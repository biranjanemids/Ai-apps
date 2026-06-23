using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Ltsc.Mgmt.V1;
using Ltsc.Server.Ca;
using Ltsc.Server.Registry;
using Xunit;

namespace Ltsc.Server.Tests;

public class RevocationTests
{
    private static byte[] MakeCsr()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        return new CertificateRequest("CN=test-device", key, HashAlgorithmName.SHA256).CreateSigningRequest();
    }

    [Fact]
    public void RevokedCertificate_FailsValidation()
    {
        var dir = Path.Combine(Path.GetTempPath(), "ca-" + Guid.NewGuid().ToString("n"));
        var ca = new CertAuthority(dir);
        using var cert = ca.SignDeviceCsr(MakeCsr(), out _);

        Assert.True(ca.ValidateDeviceCertificate(cert));   // valid before revocation
        ca.Revoke(cert.Thumbprint);
        Assert.False(ca.ValidateDeviceCertificate(cert));  // rejected after revocation
        Assert.True(ca.IsRevoked(cert.Thumbprint));
    }

    private sealed class FakeStore : IServerStore
    {
        public readonly List<string> Revoked = new();
        public void RevokeCert(string t) => Revoked.Add(t);
        public IReadOnlyCollection<string> LoadRevokedCerts() => Revoked;
        // unused
        public void UpsertDevice(DeviceRegistry.DeviceRecord r, string c = "") { }
        public IReadOnlyList<DeviceRegistry.DeviceRecord> LoadDevices() => new List<DeviceRegistry.DeviceRecord>();
        public void AddAudit(string a, string b, string c, string d, string e) { }
        public IReadOnlyList<(string, string, string, string, string)> LoadAudit(string t, int n = 200) => new List<(string, string, string, string, string)>();
        public void UpsertPolicy(string a, string b, string c) { }
        public IReadOnlyList<(string, string, string)> LoadPolicies() => new List<(string, string, string)>();
    }

    [Fact]
    public void Revocation_PersistsToStore_AndReloads()
    {
        var dir = Path.Combine(Path.GetTempPath(), "ca-" + Guid.NewGuid().ToString("n"));
        var store = new FakeStore();
        var ca = new CertAuthority(dir, store);
        using var cert = ca.SignDeviceCsr(MakeCsr(), out _);
        ca.Revoke(cert.Thumbprint);

        Assert.Contains(cert.Thumbprint, store.Revoked);
        // A fresh CA over the same store reloads the CRL and still rejects the cert.
        var ca2 = new CertAuthority(dir, store);
        Assert.True(ca2.IsRevoked(cert.Thumbprint));
    }
}

public class AlertRuleTests
{
    [Fact]
    public void OverlayCritical_RaisesAlert()
    {
        var h = new Health { OverlayMaxBytes = 1000, OverlayUsedBytes = 950 };
        Assert.NotNull(AlertRules.FromHeartbeat("t", "d", h));
        Assert.Null(AlertRules.FromHeartbeat("t", "d", new Health { OverlayMaxBytes = 1000, OverlayUsedBytes = 100 }));
    }

    [Fact]
    public void FailedResult_RaisesAlert_SucceededDoesNot()
    {
        Assert.NotNull(AlertRules.FromResult("t", "d", new CommandResult { Status = "Failed" }));
        Assert.NotNull(AlertRules.FromResult("t", "d", new CommandResult { Status = "RolledBack" }));
        Assert.Null(AlertRules.FromResult("t", "d", new CommandResult { Status = "Succeeded" }));
    }

    [Fact]
    public void ErrorEvent_RaisesAlert_InfoDoesNot()
    {
        Assert.NotNull(AlertRules.FromEvent("t", "d", new Event { Type = "uwf.reenable_failed", Severity = "error" }));
        Assert.Null(AlertRules.FromEvent("t", "d", new Event { Type = "install.deferred", Severity = "info" }));
    }

    [Fact]
    public void AlertStore_ScopesByTenant()
    {
        var s = new AlertStore();
        s.Add(new Alert("tenant-a", "d1", "warn", "x", "", DateTimeOffset.UtcNow));
        s.Add(new Alert("tenant-b", "d2", "warn", "y", "", DateTimeOffset.UtcNow));
        Assert.Single(s.ForTenant("tenant-a"));
        Assert.Single(s.ForTenant("tenant-b"));
    }
}

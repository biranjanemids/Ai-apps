using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Google.Protobuf;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Ltsc.Agent.Tests;

public class SecurityTests
{
    private static (ECDsa key, X509Certificate2 cert) MakeSigner()
    {
        var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var req = new CertificateRequest("CN=Test CA", key, HashAlgorithmName.SHA256);
        var cert = req.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddYears(1));
        return (key, cert);
    }

    private static CommandEnvelope MakeCommand() => new()
    {
        CommandId = "cmd-1",
        Capability = "app",
        Action = "install",
        Spec = ByteString.CopyFromUtf8("spec-bytes"),
        NotAfterUnix = DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeSeconds(),
    };

    [Fact]
    public void SignedCommand_Verifies()
    {
        var (key, cert) = MakeSigner();
        var cmd = MakeCommand();
        cmd.Signature = ByteString.CopyFrom(CommandSigning.Sign(cmd, key));

        Assert.True(CommandSigning.Verify(cmd, cert));
    }

    [Fact]
    public void TamperedCommand_FailsVerification()
    {
        var (key, cert) = MakeSigner();
        var cmd = MakeCommand();
        cmd.Signature = ByteString.CopyFrom(CommandSigning.Sign(cmd, key));

        cmd.Action = "factory_reset"; // attacker changes the action in flight

        Assert.False(CommandSigning.Verify(cmd, cert));
    }

    [Fact]
    public void CommandSignedByDifferentKey_FailsVerification()
    {
        var (attackerKey, _) = MakeSigner();
        var (_, trustedCert) = MakeSigner();
        var cmd = MakeCommand();
        cmd.Signature = ByteString.CopyFrom(CommandSigning.Sign(cmd, attackerKey));

        Assert.False(CommandSigning.Verify(cmd, trustedCert));
    }

    [Fact]
    public async Task ArtifactIntegrityFailure_FailsInstall_NeverRunsInstaller()
    {
        var uwf = new FakeUwf();
        var installer = new FakeInstaller();
        var detection = new FakeDetection { Installed = false };
        var fetcher = new FakeArtifactFetcher { FailIntegrity = true };
        using var ctx = new RecordingContext(uwf, installer, detection, new FakeSession(), fetcher);

        var spec = new InstallSpec
        {
            AppId = "app",
            Installer = new Installer { Type = "msi", ArtifactId = "a1", InstallCmd = "install" },
            Delivery = new Delivery { Mode = "immediate" },
            Defer = new DeferPolicy { AllowDefer = false },
            Reboot = new RebootPolicy(),
            Uwf = new UwfPolicy { Strategy = "hybrid" },
        };
        spec.Detect.Add(new DetectionRule { Kind = "registry", Key = "k", Op = "exists" });

        var module = new Ltsc.Agent.Modules.AppModule(NullLogger<Ltsc.Agent.Modules.AppModule>.Instance);
        await module.ApplyAsync(new CommandEnvelope
        {
            CommandId = "c1",
            Capability = "app",
            Action = "install",
            Spec = spec.ToByteString(),
        }, ctx, default);

        Assert.Equal(0, installer.CallCount);                  // unverified bytes never executed
        Assert.True(uwf.RollbackCalled);                       // servicing rolled back
        Assert.Equal("RolledBack", ctx.Results.Single().Status);
        Assert.Contains(ctx.Events, e => e.Type == "artifact.integrity_failed");
    }
}

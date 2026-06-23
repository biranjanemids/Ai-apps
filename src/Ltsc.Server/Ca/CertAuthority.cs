using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Ltsc.Server.Ca;

/// <summary>
/// Internal PKI (design §6, §13). On first start it mints a CA root (ECDSA
/// P-256) and a CA-signed server TLS certificate, persisting both as PFX files
/// so the identity survives restarts. Devices submit a PKCS#10 CSR at
/// enrollment and receive a short-lived CA-signed client certificate; all
/// subsequent calls are mTLS with that cert. The CA key also signs every
/// CommandEnvelope pushed to devices.
///
/// Production notes: chain this CA to the org PKI, protect the key with an HSM,
/// and add revocation (CRL/OCSP). The PFX-on-disk storage here is suitable for
/// a single-node deployment only.
/// </summary>
public sealed class CertAuthority
{
    // Enrollment token -> (tenant, group). Demo tenants: tenant-a and tenant-b.
    private static readonly Dictionary<string, (string tenant, string group)> KnownTokens = new()
    {
        ["demo-token"] = ("tenant-a", "group-default"),
        ["kiosk-token"] = ("tenant-a", "group-kiosk"),
        ["acme-token"] = ("tenant-b", "group-default"),
    };

    public X509Certificate2 CaCertificate { get; }
    public X509Certificate2 ServerCertificate { get; }

    private readonly ECDsa _caKey;
    private readonly Registry.IServerStore? _store;
    private readonly HashSet<string> _revoked;

    public CertAuthority(string stateDir, Registry.IServerStore? store = null)
    {
        _store = store;
        _revoked = store is null ? new() : new(store.LoadRevokedCerts(), StringComparer.OrdinalIgnoreCase);
        Directory.CreateDirectory(stateDir);
        var caPath = Path.Combine(stateDir, "ca.pfx");
        var serverPath = Path.Combine(stateDir, "server.pfx");

        if (File.Exists(caPath))
        {
            CaCertificate = new X509Certificate2(caPath, (string?)null,
                X509KeyStorageFlags.Exportable | X509KeyStorageFlags.EphemeralKeySet);
        }
        else
        {
            CaCertificate = CreateCaCertificate();
            File.WriteAllBytes(caPath, CaCertificate.Export(X509ContentType.Pfx));
        }
        _caKey = CaCertificate.GetECDsaPrivateKey()
                 ?? throw new InvalidOperationException("CA certificate has no private key");

        if (File.Exists(serverPath))
        {
            ServerCertificate = new X509Certificate2(serverPath, (string?)null,
                X509KeyStorageFlags.Exportable | X509KeyStorageFlags.EphemeralKeySet);
        }
        else
        {
            ServerCertificate = CreateServerCertificate();
            File.WriteAllBytes(serverPath, ServerCertificate.Export(X509ContentType.Pfx));
        }
    }

    public bool TryResolveToken(string enrollmentToken, out string tenantId, out string groupId)
    {
        if (KnownTokens.TryGetValue(enrollmentToken, out var v))
        {
            (tenantId, groupId) = v;
            return true;
        }
        tenantId = groupId = "";
        return false;
    }

    /// <summary>Signs a device CSR into a 90-day client-auth certificate.</summary>
    public X509Certificate2 SignDeviceCsr(byte[] csrDer, out DateTimeOffset notAfter)
    {
        var req = CertificateRequest.LoadSigningRequest(
            csrDer, HashAlgorithmName.SHA256,
            CertificateRequestLoadOptions.UnsafeLoadCertificateExtensions);

        notAfter = DateTimeOffset.UtcNow.AddDays(90);
        var serial = RandomNumberGenerator.GetBytes(16);
        return req.Create(CaCertificate, DateTimeOffset.UtcNow.AddMinutes(-5), notAfter, serial);
    }

    public byte[] SignCommandPayload(Func<ECDsa, byte[]> sign) => sign(_caKey);

    /// <summary>Revokes a device certificate by thumbprint (persisted CRL, design §13).</summary>
    public void Revoke(string thumbprint)
    {
        lock (_revoked)
        {
            if (_revoked.Add(thumbprint)) _store?.RevokeCert(thumbprint);
        }
    }

    public bool IsRevoked(string thumbprint)
    {
        lock (_revoked) return _revoked.Contains(thumbprint);
    }

    /// <summary>Validates a client/device certificate chains to this CA and is not revoked.</summary>
    public bool ValidateDeviceCertificate(X509Certificate2 cert)
    {
        if (IsRevoked(cert.Thumbprint)) return false;   // CRL check
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(CaCertificate);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck; // internal CRL above; OCSP: production
        return chain.Build(cert);
    }

    private static X509Certificate2 CreateCaCertificate()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var req = new CertificateRequest("CN=Ltsc Management CA", key, HashAlgorithmName.SHA256);
        req.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, true, 1, true));
        req.CertificateExtensions.Add(new X509KeyUsageExtension(
            X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign | X509KeyUsageFlags.DigitalSignature, true));
        var cert = req.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddYears(10));
        // Round-trip through PFX so the key storage flags are consistent.
        return new X509Certificate2(cert.Export(X509ContentType.Pfx), (string?)null,
            X509KeyStorageFlags.Exportable | X509KeyStorageFlags.EphemeralKeySet);
    }

    private X509Certificate2 CreateServerCertificate()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var req = new CertificateRequest("CN=ltsc-mgmtserver", key, HashAlgorithmName.SHA256);
        req.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
        req.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(
            new OidCollection { new("1.3.6.1.5.5.7.3.1") }, false)); // serverAuth
        var san = new SubjectAlternativeNameBuilder();
        san.AddDnsName("localhost");
        san.AddDnsName("ltsc-mgmtserver");
        san.AddIpAddress(System.Net.IPAddress.Loopback);
        req.CertificateExtensions.Add(san.Build());

        var serial = RandomNumberGenerator.GetBytes(16);
        using var pub = req.Create(CaCertificate, DateTimeOffset.UtcNow.AddMinutes(-5),
            DateTimeOffset.UtcNow.AddYears(2), serial);
        using var withKey = pub.CopyWithPrivateKey(key);
        return new X509Certificate2(withKey.Export(X509ContentType.Pfx), (string?)null,
            X509KeyStorageFlags.Exportable | X509KeyStorageFlags.EphemeralKeySet);
    }
}

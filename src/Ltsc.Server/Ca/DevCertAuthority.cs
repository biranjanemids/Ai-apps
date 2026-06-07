using System.Security.Cryptography;

namespace Ltsc.Server.Ca;

/// <summary>
/// Placeholder for the design's CertAuthority (§6, §13). Production validates a
/// group enrollment token and signs a short-lived X.509 device certificate from
/// the submitted CSR. This scaffold validates a static token and issues an
/// opaque bearer session token so the loop runs without PKI plumbing.
/// </summary>
public sealed class DevCertAuthority
{
    // Demo group tokens -> group id. Replace with a real token store.
    private static readonly Dictionary<string, string> KnownTokens = new()
    {
        ["demo-token"] = "group-default",
        ["kiosk-token"] = "group-kiosk",
    };

    public bool TryResolveGroup(string enrollmentToken, out string groupId) =>
        KnownTokens.TryGetValue(enrollmentToken, out groupId!);

    public (string sessionToken, DateTimeOffset notAfter) IssueSession(string deviceId)
    {
        var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        return (token, DateTimeOffset.UtcNow.AddDays(90));
    }
}

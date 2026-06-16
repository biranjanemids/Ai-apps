using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Ltsc.Server.Services;

public enum Role { None = 0, Viewer = 1, Operator = 2, Admin = 3 }

/// <summary>
/// Console/API authentication + RBAC + tenant scoping (design §12, §13). Accepts
/// either a static bearer token (demo/dev) or an OIDC-style JWT (HS256, validated
/// against Ltsc:Oidc:Secret) carrying `role` and `tenant` claims — so a real IdP
/// can front the console. Each token resolves to (actor, role, tenant); endpoints
/// require a minimum role and scope every query to the caller's tenant.
/// </summary>
public sealed class AdminAuth
{
    private readonly Dictionary<string, (string actor, Role role, string tenant)> _tokens;
    private readonly byte[]? _oidcSecret;

    public AdminAuth(IConfiguration config)
    {
        _tokens = new()
        {
            ["admin-token"] = ("admin", Role.Admin, "tenant-a"),
            ["operator-token"] = ("operator", Role.Operator, "tenant-a"),
            ["viewer-token"] = ("viewer", Role.Viewer, "tenant-a"),
            ["acme-admin"] = ("acme-admin", Role.Admin, "tenant-b"),
        };
        foreach (var kv in config.GetSection("Ltsc:AdminTokens").GetChildren())
        {
            var parts = (kv.Value ?? "").Split(':', 3);
            if (parts.Length == 3 && Enum.TryParse<Role>(parts[1], true, out var r))
                _tokens[kv.Key] = (parts[0], r, parts[2]);
        }
        var secret = config["Ltsc:Oidc:Secret"];
        if (!string.IsNullOrEmpty(secret)) _oidcSecret = Encoding.UTF8.GetBytes(secret);
    }

    public (string actor, Role role, string tenant) Resolve(HttpContext ctx)
    {
        var header = ctx.Request.Headers.Authorization.ToString();
        var token = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? header[7..] : header;
        if (_tokens.TryGetValue(token, out var v)) return v;
        return TryValidateJwt(token) ?? ("", Role.None, "");
    }

    public (string actor, string tenant)? Require(HttpContext ctx, Role minimum)
    {
        var (actor, role, tenant) = Resolve(ctx);
        return role >= minimum ? (string.IsNullOrEmpty(actor) ? "?" : actor, tenant) : null;
    }

    /// <summary>Minimal HS256 JWT validation: signature + exp + role/tenant claims.</summary>
    private (string, Role, string)? TryValidateJwt(string token)
    {
        if (_oidcSecret is null) return null;
        var parts = token.Split('.');
        if (parts.Length != 3) return null;
        try
        {
            var signing = Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}");
            var expected = HMACSHA256.HashData(_oidcSecret, signing);
            if (!CryptographicOperations.FixedTimeEquals(expected, B64Url(parts[2]))) return null;

            using var doc = JsonDocument.Parse(B64Url(parts[1]));
            var root = doc.RootElement;
            if (root.TryGetProperty("exp", out var exp) && exp.GetInt64() < DateTimeOffset.UtcNow.ToUnixTimeSeconds())
                return null;
            var role = root.TryGetProperty("role", out var rv) && Enum.TryParse<Role>(rv.GetString(), true, out var r) ? r : Role.None;
            var tenant = root.TryGetProperty("tenant", out var tv) ? tv.GetString() ?? "" : "";
            var actor = root.TryGetProperty("sub", out var sv) ? sv.GetString() ?? "jwt" : "jwt";
            return role == Role.None ? null : (actor, role, tenant);
        }
        catch { return null; }
    }

    private static byte[] B64Url(string s)
    {
        s = s.Replace('-', '+').Replace('_', '/');
        switch (s.Length % 4) { case 2: s += "=="; break; case 3: s += "="; break; }
        return Convert.FromBase64String(s);
    }
}

namespace Ltsc.Server.Services;

public enum Role { None = 0, Viewer = 1, Operator = 2, Admin = 3 }

/// <summary>
/// Console/API authentication + RBAC (design §13). Bearer tokens map to roles;
/// each endpoint requires a minimum role (Viewer reads, Operator issues commands,
/// Admin authors policy + reads the audit log). This is a credible single-node
/// scheme; production fronts it with OIDC and per-user identities.
/// </summary>
public sealed class AdminAuth
{
    private readonly Dictionary<string, (string actor, Role role)> _tokens;

    public AdminAuth(IConfiguration config)
    {
        // Configurable via Ltsc:AdminTokens:{token}={actor}:{role}; demo defaults below.
        _tokens = new()
        {
            ["admin-token"] = ("admin", Role.Admin),
            ["operator-token"] = ("operator", Role.Operator),
            ["viewer-token"] = ("viewer", Role.Viewer),
        };
        foreach (var kv in config.GetSection("Ltsc:AdminTokens").GetChildren())
        {
            var parts = (kv.Value ?? "").Split(':', 2);
            if (parts.Length == 2 && Enum.TryParse<Role>(parts[1], true, out var r))
                _tokens[kv.Key] = (parts[0], r);
        }
    }

    public (string actor, Role role) Resolve(HttpContext ctx)
    {
        var header = ctx.Request.Headers.Authorization.ToString();
        var token = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? header[7..] : header;
        return _tokens.TryGetValue(token, out var v) ? v : ("", Role.None);
    }

    /// <summary>Returns an actor name if the caller meets the minimum role, else null.</summary>
    public string? Require(HttpContext ctx, Role minimum)
    {
        var (actor, role) = Resolve(ctx);
        return role >= minimum ? (string.IsNullOrEmpty(actor) ? "?" : actor) : null;
    }
}

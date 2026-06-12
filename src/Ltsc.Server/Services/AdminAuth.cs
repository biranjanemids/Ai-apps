namespace Ltsc.Server.Services;

public enum Role { None = 0, Viewer = 1, Operator = 2, Admin = 3 }

/// <summary>
/// Console/API authentication + RBAC + tenant scoping (design §12, §13). Bearer
/// tokens map to an actor, a role, and a tenant; each endpoint requires a minimum
/// role, and every query is scoped to the caller's tenant so admins of one tenant
/// never see or act on another tenant's devices.
/// </summary>
public sealed class AdminAuth
{
    private readonly Dictionary<string, (string actor, Role role, string tenant)> _tokens;

    public AdminAuth(IConfiguration config)
    {
        // Demo defaults: tenant-a (admin/operator/viewer) + tenant-b (acme-admin).
        _tokens = new()
        {
            ["admin-token"] = ("admin", Role.Admin, "tenant-a"),
            ["operator-token"] = ("operator", Role.Operator, "tenant-a"),
            ["viewer-token"] = ("viewer", Role.Viewer, "tenant-a"),
            ["acme-admin"] = ("acme-admin", Role.Admin, "tenant-b"),
        };
        // Override/extend via Ltsc:AdminTokens:{token}={actor}:{role}:{tenant}.
        foreach (var kv in config.GetSection("Ltsc:AdminTokens").GetChildren())
        {
            var parts = (kv.Value ?? "").Split(':', 3);
            if (parts.Length == 3 && Enum.TryParse<Role>(parts[1], true, out var r))
                _tokens[kv.Key] = (parts[0], r, parts[2]);
        }
    }

    public (string actor, Role role, string tenant) Resolve(HttpContext ctx)
    {
        var header = ctx.Request.Headers.Authorization.ToString();
        var token = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? header[7..] : header;
        return _tokens.TryGetValue(token, out var v) ? v : ("", Role.None, "");
    }

    /// <summary>Returns the caller (actor, tenant) if it meets the minimum role, else null.</summary>
    public (string actor, string tenant)? Require(HttpContext ctx, Role minimum)
    {
        var (actor, role, tenant) = Resolve(ctx);
        return role >= minimum ? (string.IsNullOrEmpty(actor) ? "?" : actor, tenant) : null;
    }
}

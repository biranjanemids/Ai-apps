namespace Ltsc.Server.Registry;

public sealed record OpsFilter(string? Band = null, bool? Online = null, string? Group = null, bool? Drift = null);
public sealed record OpsIntent(string Capability, string Action, OpsFilter Filter, string Summary);

/// <summary>
/// AI Ops copilot: turns a natural-language request ("reboot all critical kiosks
/// that are offline") into a structured, auditable fleet action plan. The default
/// translator is a deterministic grammar (no external dependency, fully testable);
/// an LLM-backed <see cref="IIntentTranslator"/> can drop in behind the same
/// interface (e.g. Claude) for free-form phrasing — the executor stays identical,
/// so the model never touches the fleet directly, only proposes a typed plan.
/// </summary>
public interface IIntentTranslator
{
    OpsIntent? Translate(string query);
}

public sealed class RuleIntentTranslator : IIntentTranslator
{
    public OpsIntent? Translate(string query)
    {
        if (string.IsNullOrWhiteSpace(query)) return null;
        var q = query.ToLowerInvariant();

        // Action verb -> (capability, action). Order matters (most specific first).
        (string cap, string act)? verb =
            q.Contains("collect logs") || q.Contains("log") ? ("command", "collect_logs") :
            q.Contains("inventory") || q.Contains("collect") ? ("inventory", "collect") :
            q.Contains("reboot") || q.Contains("restart") && !q.Contains("service") ? ("command", "reboot") :
            q.Contains("shutdown") || q.Contains("power off") ? ("command", "shutdown") :
            q.Contains("restart service") ? ("command", "restart_services") :
            q.Contains("scan") ? ("update", "scan") :
            q.Contains("update") || q.Contains("patch") ? ("update", "install") :
            q.Contains("shadow") ? ("shadow", "start") :
            null;
        if (verb is null) return null;

        var band = q.Contains("critical") ? "critical" : q.Contains("warning") ? "warning"
            : q.Contains("healthy") ? "healthy" : null;
        bool? online = q.Contains("offline") ? false : q.Contains("online") ? true : null;
        bool? drift = q.Contains("out of policy") || q.Contains("drift") || q.Contains("drifted") ? true
            : q.Contains("in policy") || q.Contains("compliant") ? false : null;
        string? group = q.Contains("kiosk") ? "group-kiosk" : ExtractGroup(q);

        var filter = new OpsFilter(band, online, group, drift);
        var summary = $"{verb.Value.cap}:{verb.Value.act} -> {Describe(filter)}";
        return new OpsIntent(verb.Value.cap, verb.Value.act, filter, summary);
    }

    private static string? ExtractGroup(string q)
    {
        var idx = q.IndexOf("group-", StringComparison.Ordinal);
        if (idx < 0) return null;
        var rest = q[idx..].Split(' ', ',', '.')[0];
        return rest.Length > "group-".Length ? rest : null;
    }

    private static string Describe(OpsFilter f)
    {
        var parts = new List<string>();
        if (f.Band is not null) parts.Add($"{f.Band} health");
        if (f.Online == true) parts.Add("online"); if (f.Online == false) parts.Add("offline");
        if (f.Drift == true) parts.Add("policy-drifted"); if (f.Drift == false) parts.Add("in-policy");
        if (f.Group is not null) parts.Add($"in {f.Group}");
        return parts.Count == 0 ? "all devices" : string.Join(", ", parts);
    }
}

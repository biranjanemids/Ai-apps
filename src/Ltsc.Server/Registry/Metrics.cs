using System.Collections.Concurrent;
using System.Text;

namespace Ltsc.Server.Registry;

/// <summary>
/// Operational metrics in Prometheus text-exposition format. Enterprises will not
/// run a fleet controller they cannot alert on, so the server exposes counters
/// (enrollments, dispatches, reconciles, posture violations) plus live gauges
/// (fleet size, online, health bands) at /metrics, with /healthz and /readyz for
/// liveness and dependency readiness.
/// </summary>
public sealed class Metrics
{
    private readonly ConcurrentDictionary<string, long> _counters = new();

    public void Inc(string name, long by = 1) => _counters.AddOrUpdate(name, by, (_, old) => old + by);
    public long Get(string name) => _counters.TryGetValue(name, out var v) ? v : 0;

    // Counter names (single place so producers and the renderer agree).
    public const string Enrollments = "ltsc_enrollments_total";
    public const string Connects = "ltsc_device_connects_total";
    public const string Disconnects = "ltsc_device_disconnects_total";
    public const string Heartbeats = "ltsc_heartbeats_total";
    public const string CommandsDispatched = "ltsc_commands_dispatched_total";
    public const string CommandResults = "ltsc_command_results_total";
    public const string CommandFailures = "ltsc_command_failures_total";
    public const string PolicyPulls = "ltsc_policy_pulls_total";
    public const string PostureViolations = "ltsc_posture_violations_total";
    public const string CertsRevoked = "ltsc_certs_revoked_total";

    private static readonly (string Name, string Help)[] CounterMeta =
    {
        (Enrollments, "Devices enrolled (CSR signed)"),
        (Connects, "DeviceLink stream connects"),
        (Disconnects, "DeviceLink stream disconnects"),
        (Heartbeats, "Heartbeats received"),
        (CommandsDispatched, "Commands signed and dispatched"),
        (CommandResults, "Command results received"),
        (CommandFailures, "Command results that failed or rolled back"),
        (PolicyPulls, "Policy snapshots served"),
        (PostureViolations, "Zero-trust posture violations detected"),
        (CertsRevoked, "Device certificates revoked"),
    };

    /// <summary>Renders counters plus live fleet gauges in Prometheus text format.</summary>
    public string Render(DeviceRegistry devices, DeviceRouter router, InventoryStore inv, AlertStore alerts)
    {
        var sb = new StringBuilder();
        foreach (var (name, help) in CounterMeta)
        {
            sb.Append("# HELP ").Append(name).Append(' ').Append(help).Append('\n');
            sb.Append("# TYPE ").Append(name).Append(" counter\n");
            sb.Append(name).Append(' ').Append(Get(name)).Append('\n');
        }

        var all = devices.All();
        var online = all.Count(d => router.IsOnline(d.DeviceId));
        var quarantined = all.Count(d => d.Quarantined);

        Gauge(sb, "ltsc_devices_total", "Devices enrolled", all.Count);
        Gauge(sb, "ltsc_devices_online", "Devices with a live stream", online);
        Gauge(sb, "ltsc_devices_quarantined", "Devices failing zero-trust posture", quarantined);

        // Health-band distribution drives the fleet SLO dashboard.
        var bands = new Dictionary<string, int> { ["healthy"] = 0, ["warning"] = 0, ["critical"] = 0 };
        foreach (var d in all)
        {
            var fails = inv.GetResults(d.DeviceId).Count(r => r.Status is "Failed" or "RolledBack");
            var band = FleetHealth.Score(router.IsOnline(d.DeviceId), d.LastSeen,
                inv.GetHealth(d.DeviceId), inv.GetInventory(d.DeviceId), fails).Band;
            bands[band] = bands.GetValueOrDefault(band) + 1;
        }
        sb.Append("# HELP ltsc_devices_health Devices by predictive health band\n# TYPE ltsc_devices_health gauge\n");
        foreach (var (band, n) in bands)
            sb.Append("ltsc_devices_health{band=\"").Append(band).Append("\"} ").Append(n).Append('\n');

        return sb.ToString();
    }

    private static void Gauge(StringBuilder sb, string name, string help, long value)
    {
        sb.Append("# HELP ").Append(name).Append(' ').Append(help).Append('\n');
        sb.Append("# TYPE ").Append(name).Append(" gauge\n");
        sb.Append(name).Append(' ').Append(value).Append('\n');
    }
}

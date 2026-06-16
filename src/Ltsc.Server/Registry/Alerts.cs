using System.Collections.Concurrent;
using Ltsc.Mgmt.V1;

namespace Ltsc.Server.Registry;

public sealed record Alert(string Tenant, string DeviceId, string Severity, string Type, string Detail, DateTimeOffset Ts);

/// <summary>Tenant-scoped, in-memory alert feed (design §12 health/alerting).</summary>
public sealed class AlertStore
{
    private readonly ConcurrentQueue<Alert> _alerts = new();

    public void Add(Alert a)
    {
        _alerts.Enqueue(a);
        while (_alerts.Count > 1000 && _alerts.TryDequeue(out _)) { }
    }

    public IReadOnlyList<Alert> ForTenant(string tenant) =>
        _alerts.Where(a => a.Tenant == tenant).Reverse().Take(200).ToArray();
}

/// <summary>
/// Pure alert rules over the signals devices already report (design §12). Kept
/// side-effect-free so they're unit-testable; the DeviceLink stream feeds them.
/// </summary>
public static class AlertRules
{
    public static Alert? FromHeartbeat(string tenant, string device, Health? h)
    {
        if (h is null) return null;
        if (h.OverlayMaxBytes > 0 && h.OverlayUsedBytes >= 0.9 * h.OverlayMaxBytes)
            return new(tenant, device, "warn", "uwf.overlay_critical",
                $"overlay {h.OverlayUsedBytes}/{h.OverlayMaxBytes} bytes", DateTimeOffset.UtcNow);
        return null;
    }

    public static Alert? FromResult(string tenant, string device, CommandResult r) =>
        r.Status is "Failed" or "RolledBack"
            ? new(tenant, device, "error", "command.failed", $"{r.CommandId}: {r.StdoutTail}", DateTimeOffset.UtcNow)
            : null;

    public static Alert? FromEvent(string tenant, string device, Event e) =>
        e.Severity == "error"
            ? new(tenant, device, "error", e.Type, e.PayloadJson, DateTimeOffset.UtcNow)
            : null;
}

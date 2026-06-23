using Ltsc.Mgmt.V1;

namespace Ltsc.Server.Registry;

/// <summary>
/// Predictive fleet-health scoring (futuristic use case: get ahead of failures
/// instead of reacting to tickets). A device's telemetry — disk headroom, UWF
/// overlay pressure, reachability, pending reboots, and recent command failures —
/// is folded into a 0–100 health score with human-readable risk reasons, so the
/// console can triage the fleet and flag at-risk devices before they fall over.
///
/// This is transparent rule-based risk scoring (auditable, deterministic). A
/// trend/ML model can later replace <see cref="Score"/> behind the same shape.
/// </summary>
public static class FleetHealth
{
    public sealed record Result(int Score, string Band, IReadOnlyList<string> Risks);

    public static Result Score(
        bool online,
        DateTimeOffset lastSeen,
        Health? health,
        InventoryReport? inv,
        int recentFailures)
    {
        var score = 100;
        var risks = new List<string>();

        var offlineFor = DateTimeOffset.UtcNow - lastSeen;
        if (!online && offlineFor > TimeSpan.FromHours(24)) { score -= 55; risks.Add($"unreachable for {offlineFor.TotalHours:F0}h"); }
        else if (!online && offlineFor > TimeSpan.FromHours(1)) { score -= 10; risks.Add("offline"); }

        if (inv is { TotalDiskBytes: > 0 })
        {
            var freePct = 100.0 * inv.FreeDiskBytes / inv.TotalDiskBytes;
            if (freePct < 10) { score -= 30; risks.Add($"disk critical ({freePct:F0}% free) — exhaustion imminent"); }
            else if (freePct < 20) { score -= 15; risks.Add($"disk low ({freePct:F0}% free)"); }
        }

        if (health is { OverlayMaxBytes: > 0 })
        {
            var usedPct = 100.0 * health.OverlayUsedBytes / health.OverlayMaxBytes;
            if (usedPct >= 90) { score -= 30; risks.Add($"UWF overlay {usedPct:F0}% — reboot needed soon"); }
            else if (usedPct >= 75) { score -= 15; risks.Add($"UWF overlay pressure ({usedPct:F0}%)"); }
        }

        if (health?.RebootPending == true) { score -= 10; risks.Add("reboot pending"); }
        if (recentFailures > 0) { score -= Math.Min(30, recentFailures * 10); risks.Add($"{recentFailures} recent command failure(s)"); }

        score = Math.Clamp(score, 0, 100);
        var band = score >= 80 ? "healthy" : score >= 50 ? "warning" : "critical";
        return new Result(score, band, risks);
    }
}

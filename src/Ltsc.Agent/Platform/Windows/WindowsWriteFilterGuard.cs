#if WINDOWS
using System.Management;
using System.Runtime.Versioning;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging;

namespace Ltsc.Agent.Platform.Windows;

/// <summary>
/// Unified Write Filter control via the UWF WMI provider
/// (root\standardcimv2\embedded, class UWF_Filter), design §4.5/§8.6.
///
/// NOTE: A robust persistent change on an LTSC device with UWF enabled requires
/// the full servicing cycle (disable filter → reboot → write → enable → reboot).
/// This implementation reports the strategy and commits in place where possible;
/// the disable/reboot orchestration is wired through the resumable command path
/// (design §8.4) and is completed in the imaging/update milestone. Validate on a
/// real UWF-enabled device before relying on persistence.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsWriteFilterGuard : IWriteFilterGuard
{
    private const string Scope = @"root\standardcimv2\embedded";
    private readonly ILogger<WindowsWriteFilterGuard> _log;

    public WindowsWriteFilterGuard(ILogger<WindowsWriteFilterGuard> log) => _log = log;

    public bool IsEnabled()
    {
        try
        {
            using var searcher = new ManagementObjectSearcher(Scope, "SELECT CurrentEnabled FROM UWF_Filter");
            foreach (var o in searcher.Get())
                return (bool)(o["CurrentEnabled"] ?? false);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "UWF query failed; assuming disabled");
        }
        return false;
    }

    public ServicingPlan EnterServicing(UwfPolicy policy, IReadOnlyList<string> touchedPaths)
    {
        // Hybrid: prefer commit-in-place; the disable/reboot fallback is owned by
        // the resumable command path. Here we proceed and commit on exit.
        return new ServicingPlan(ServicingStrategy.CommitInPlace, RebootRequired: false);
    }

    public bool ExitServicing(ServicingPlan plan)
    {
        // Best-effort: nothing to undo for commit-in-place. Real persistence
        // commits specific files/registry via UWF_File.CommitFile /
        // UWF_RegistryFilter.CommitRegistry, added with the servicing cycle.
        return IsEnabled();
    }

    public void Rollback(ServicingPlan plan) =>
        _log.LogWarning("UWF rollback requested ({Strategy})", plan.Strategy);

    /// <summary>Enable/disable the filter (takes effect after reboot).</summary>
    internal void SetEnabled(bool enabled)
    {
        using var searcher = new ManagementObjectSearcher(Scope, "SELECT * FROM UWF_Filter");
        foreach (ManagementObject filter in searcher.Get())
            filter.InvokeMethod(enabled ? "Enable" : "Disable", Array.Empty<object>());
    }
}
#endif

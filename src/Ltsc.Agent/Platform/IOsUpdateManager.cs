using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging;

namespace Ltsc.Agent.Platform;

public sealed record UpdateInstallResult(int InstalledCount, bool RebootRequired, string Detail);

/// <summary>
/// Windows Update control (design §10). The Windows production implementation
/// drives the WUA COM API (IUpdateSession/IUpdateSearcher/IUpdateInstaller) or
/// UsoClient/CSP policy; this cross-platform default simulates a scan/install so
/// the update state machine is runnable and testable off Windows.
/// </summary>
public interface IOsUpdateManager
{
    Task<IReadOnlyList<UpdateInfo>> ScanAsync(bool includeFeatureUpdates, CancellationToken ct);
    Task<UpdateInstallResult> InstallAsync(IReadOnlyList<UpdateInfo> updates, CancellationToken ct);
}

public sealed class DefaultOsUpdateManager : IOsUpdateManager
{
    private readonly ILogger<DefaultOsUpdateManager> _log;
    public DefaultOsUpdateManager(ILogger<DefaultOsUpdateManager> log) => _log = log;

    public Task<IReadOnlyList<UpdateInfo>> ScanAsync(bool includeFeatureUpdates, CancellationToken ct)
    {
        var list = new List<UpdateInfo>
        {
            new() { UpdateId = "u-2024-06-cu", Title = "Cumulative Update", Kb = "KB5039999", SizeBytes = 380L << 20, RebootRequired = true },
            new() { UpdateId = "u-defender", Title = "Defender definitions", Kb = "KB2267602", SizeBytes = 90L << 20, RebootRequired = false },
        };
        if (includeFeatureUpdates)
            list.Add(new UpdateInfo { UpdateId = "u-feature-23h2", Title = "Feature update to 23H2", Kb = "", SizeBytes = 4L << 30, RebootRequired = true, IsFeatureUpdate = true });
        _log.LogInformation("[stub] WUA scan -> {Count} updates", list.Count);
        return Task.FromResult<IReadOnlyList<UpdateInfo>>(list);
    }

    public Task<UpdateInstallResult> InstallAsync(IReadOnlyList<UpdateInfo> updates, CancellationToken ct)
    {
        var reboot = updates.Any(u => u.RebootRequired);
        _log.LogInformation("[stub] WUA install -> {Count} updates, reboot={Reboot}", updates.Count, reboot);
        return Task.FromResult(new UpdateInstallResult(updates.Count, reboot, $"installed {updates.Count} update(s)"));
    }
}

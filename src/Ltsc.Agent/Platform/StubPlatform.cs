using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging;

namespace Ltsc.Agent.Platform;

/// <summary>
/// Cross-platform stub implementations so the agent and its install state
/// machine run and can be tested off-Windows. They simulate realistic behavior
/// (UWF enabled, an installer that asks for a reboot, detection that flips to
/// "installed" after the run). Replace with the Windows implementations
/// (UWF WMI, msiexec/DISM, WTS session APIs) for production.
/// </summary>
public sealed class StubWriteFilterGuard : IWriteFilterGuard
{
    private readonly ILogger<StubWriteFilterGuard> _log;
    public StubWriteFilterGuard(ILogger<StubWriteFilterGuard> log) => _log = log;

    public bool IsEnabled() => true; // pretend UWF is on, the interesting case

    public ServicingPlan EnterServicing(UwfPolicy policy, IReadOnlyList<string> touchedPaths)
    {
        var strategy = policy.Strategy switch
        {
            "always_disable" => ServicingStrategy.DisableCycle,
            "commit_only" => ServicingStrategy.CommitInPlace,
            // hybrid: commit in place if every touched path is declared committable
            _ => touchedPaths.All(p => policy.CommittablePaths.Any(c => p.StartsWith(c, StringComparison.OrdinalIgnoreCase)))
                ? ServicingStrategy.CommitInPlace
                : ServicingStrategy.DisableCycle,
        };
        _log.LogInformation("UWF EnterServicing -> {Strategy}", strategy);
        // Stub never actually reboots; report the plan so the state machine logic is exercised.
        return new ServicingPlan(strategy, RebootRequired: false);
    }

    public bool ExitServicing(ServicingPlan plan)
    {
        _log.LogInformation("UWF ExitServicing ({Strategy}) -> protection re-enabled", plan.Strategy);
        return true;
    }

    public void Rollback(ServicingPlan plan) =>
        _log.LogWarning("UWF Rollback ({Strategy}) -> restored prior protection state", plan.Strategy);
}

public sealed class StubInstallerRunner : IInstallerRunner
{
    public Task<InstallerResult> RunAsync(Installer installer, string artifactPath, CancellationToken ct)
    {
        // Simulate an MSI that completes and requests a reboot (exit 3010).
        var exit = installer.ValidExitCodes.Contains(3010) ? 3010 : 0;
        var rebootRequired = exit is 3010 or 1641;
        return Task.FromResult(new InstallerResult(exit, rebootRequired,
            $"[stub] ran '{installer.InstallCmd}' -> exit {exit}"));
    }
}

/// <summary>Flips to "installed" after the install runs, like a real detection rule.</summary>
public sealed class StubDetectionProbe : IDetectionProbe
{
    private bool _installed;
    public void MarkInstalled() => _installed = true;
    public bool Evaluate(DetectionRule rule) => _installed;
}

/// <summary>Headless by default: proceeds immediately (matches kiosk/unattended behavior).</summary>
public sealed class StubSessionUi : ISessionUi
{
    public bool HasInteractiveSession() => false;
    public Task<bool> PromptInstallAsync(string text, int snoozeRemaining, DateTimeOffset deadline, CancellationToken ct) => Task.FromResult(true);
    public Task<bool> PromptRebootAsync(DateTimeOffset deadline, CancellationToken ct) => Task.FromResult(true);
}

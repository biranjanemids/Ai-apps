using Ltsc.Mgmt.V1;

namespace Ltsc.Agent.Platform;

/// <summary>
/// Unified Write Filter control (design §4.5, §8.6). The Windows implementation
/// drives the UWF_* WMI classes; the stub below lets the state machine run and
/// be tested off-Windows.
/// </summary>
public interface IWriteFilterGuard
{
    bool IsEnabled();

    /// <summary>
    /// Brackets a persistent change. Returns the strategy actually taken so the
    /// caller can report it and decide on reboots:
    ///  - CommitInPlace: no reboot needed (paths were committable)
    ///  - DisableCycle:  filter disabled; a reboot is required before applying
    /// </summary>
    ServicingPlan EnterServicing(UwfPolicy policy, IReadOnlyList<string> touchedPaths);

    /// <summary>Re-enables protection / commits. Returns true if UWF is protecting again.</summary>
    bool ExitServicing(ServicingPlan plan);

    /// <summary>Restores prior protection state after a failed servicing attempt.</summary>
    void Rollback(ServicingPlan plan);
}

public enum ServicingStrategy { None, CommitInPlace, DisableCycle }

public sealed record ServicingPlan(ServicingStrategy Strategy, bool RebootRequired);

/// <summary>Runs an installer and maps its exit code (design §8.4).</summary>
public interface IInstallerRunner
{
    Task<InstallerResult> RunAsync(Installer installer, string artifactPath, CancellationToken ct);
}

public sealed record InstallerResult(int ExitCode, bool RebootRequired, string StdoutTail);

/// <summary>Evaluates a detection / verify rule (design §8.5).</summary>
public interface IDetectionProbe
{
    bool Evaluate(DetectionRule rule);
}

/// <summary>
/// Interactive prompts surfaced via the per-user SessionAgent (design §4.1).
/// Returns true to proceed now, false to snooze.
/// </summary>
public interface ISessionUi
{
    bool HasInteractiveSession();
    Task<bool> PromptInstallAsync(string text, int snoozeRemaining, DateTimeOffset deadline, CancellationToken ct);
    Task<bool> PromptRebootAsync(DateTimeOffset deadline, CancellationToken ct);
}

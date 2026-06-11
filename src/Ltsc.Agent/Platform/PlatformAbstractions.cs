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

/// <summary>
/// Downloads an artifact and verifies its integrity (chunk hashes + whole-file
/// SHA-256) before returning the local path (design §5, §8.6). Implementations
/// throw InvalidDataException on any mismatch so installs fail closed.
/// </summary>
public interface IArtifactFetcher
{
    Task<string> FetchAsync(string artifactId, byte[] expectedSha256, CancellationToken ct);
}

/// <summary>Uploads a local file (captured image, log bundle) to the server (design §5, §11).</summary>
public interface IArtifactUploader
{
    Task<string> UploadAsync(string path, CancellationToken ct);   // returns server artifact id
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

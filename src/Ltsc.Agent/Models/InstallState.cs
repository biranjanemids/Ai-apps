namespace Ltsc.Agent.Models;

/// <summary>
/// Stages of the App-deployment state machine (design §8.4 / §8.7). Persisted to
/// LocalStore so an install resumes at the recorded stage across the reboots a
/// UWF disable-cycle or a required reboot may introduce.
/// </summary>
public enum InstallState
{
    Queued,
    Scheduled,
    WaitingWindow,
    AwaitingUserDefer,
    PreCheck,
    AlreadyInstalled,
    EnterServicing,
    Downloading,
    Installing,
    ConfiguringApp,
    Verifying,
    ExitServicing,
    PendingReboot,
    PostRebootVerify,
    Succeeded,
    Failed,
    RolledBack,
}

/// <summary>Persisted, resumable record of an in-flight install command.</summary>
public sealed class InstallJob
{
    public required string CommandId { get; init; }
    public required byte[] Spec { get; init; }          // serialized InstallSpec
    public InstallState State { get; set; } = InstallState.Queued;
    public int DeferCount { get; set; }
    public DateTimeOffset FirstEligibleUtc { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? EffectiveDeadlineUtc { get; set; }
    public bool UwfWasEnabled { get; set; }
    public bool RebootPending { get; set; }
    public string LastDetail { get; set; } = "";
}

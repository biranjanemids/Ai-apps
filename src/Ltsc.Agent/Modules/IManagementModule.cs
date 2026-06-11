using Ltsc.Agent.Models;
using Ltsc.Agent.Platform;
using Ltsc.Agent.Storage;
using Ltsc.Mgmt.V1;

namespace Ltsc.Agent.Modules;

/// <summary>
/// Services and reporting hooks a module uses while applying a command
/// (design §4.3). Progress/Event/Result flow back to the server over the
/// DeviceLink stream, buffered in the outbox when offline.
/// </summary>
public interface IModuleContext
{
    IWriteFilterGuard Uwf { get; }
    IInstallerRunner Installer { get; }
    IDetectionProbe Detection { get; }
    ISessionUi Session { get; }
    LocalStore Store { get; }

    // State is a free string (e.g. an InstallState name, or a config profile id)
    // so any capability can report progress, not just app installs.
    Task ReportProgressAsync(string commandId, string state, int percent, string detail);
    Task ReportResultAsync(CommandResult result);
    Task ReportEventAsync(string type, string severity, string payloadJson);
}

/// <summary>
/// A capability handler (design §4.3). Idempotent, desired-state appliers.
/// </summary>
public interface IManagementModule
{
    string Capability { get; }

    /// <summary>Handle a freshly received command.</summary>
    Task ApplyAsync(CommandEnvelope cmd, IModuleContext ctx, CancellationToken ct);

    /// <summary>Resume an in-flight job recovered from LocalStore after a restart.</summary>
    Task ResumeAsync(InstallJob job, IModuleContext ctx, CancellationToken ct);

    /// <summary>
    /// Bring the device to the desired state described by a policy snapshot
    /// (design §7). Modules that aren't policy-driven implement this as a no-op.
    /// </summary>
    Task ReconcileAsync(PolicySnapshot policy, IModuleContext ctx, CancellationToken ct);
}

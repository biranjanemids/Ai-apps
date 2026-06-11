using Ltsc.Agent.Comm;
using Ltsc.Agent.Models;
using Ltsc.Agent.Modules;
using Ltsc.Agent.Platform;
using Ltsc.Agent.Storage;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging;

namespace Ltsc.Agent;

/// <summary>
/// Routes server commands to capability modules and reports results back over
/// the DeviceLink stream (design §4.2). Also resumes in-flight jobs on startup.
/// </summary>
public sealed class Orchestrator : IModuleContext
{
    private readonly CommChannel _comm;
    private readonly Dictionary<string, IManagementModule> _modules;
    private readonly ILogger<Orchestrator> _log;

    public IWriteFilterGuard Uwf { get; }
    public IInstallerRunner Installer { get; }
    public IDetectionProbe Detection { get; }
    public ISessionUi Session { get; }
    public LocalStore Store { get; }

    public Orchestrator(
        CommChannel comm,
        IEnumerable<IManagementModule> modules,
        IWriteFilterGuard uwf,
        IInstallerRunner installer,
        IDetectionProbe detection,
        ISessionUi session,
        LocalStore store,
        ILogger<Orchestrator> log)
    {
        _comm = comm;
        _modules = modules.ToDictionary(m => m.Capability);
        Uwf = uwf;
        Installer = installer;
        Detection = detection;
        Session = session;
        Store = store;
        _log = log;
        _comm.OnCommand = DispatchAsync;
    }

    public async Task DispatchAsync(CommandEnvelope cmd)
    {
        if (cmd.NotAfterUnix > 0 && DateTimeOffset.UtcNow.ToUnixTimeSeconds() > cmd.NotAfterUnix)
        {
            _log.LogWarning("Command {Id} expired; skipping", cmd.CommandId);
            return;
        }
        if (!_modules.TryGetValue(cmd.Capability, out var module))
        {
            _log.LogWarning("No module for capability {Cap}", cmd.Capability);
            return;
        }
        // Production verifies cmd.Signature before executing (design §13).
        try { await module.ApplyAsync(cmd, this, CancellationToken.None); }
        catch (Exception ex) { _log.LogError(ex, "Command {Id} failed", cmd.CommandId); }
    }

    /// <summary>Resume install jobs that were mid-flight before a restart/reboot.</summary>
    public async Task ResumeJobsAsync()
    {
        foreach (var job in Store.LoadResumableJobs())
        {
            if (_modules.TryGetValue("app", out var module))
                await module.ResumeAsync(job, this, CancellationToken.None);
        }
    }

    /// <summary>Drive every module to the desired state in a policy snapshot (design §7).</summary>
    public async Task ReconcilePolicyAsync(PolicySnapshot snapshot)
    {
        foreach (var module in _modules.Values)
            await module.ReconcileAsync(snapshot, this, CancellationToken.None);
    }

    // ---- IModuleContext reporting hooks ----
    public Task ReportProgressAsync(string commandId, string state, int percent, string detail) =>
        _comm.SendAsync(new AgentMessage
        {
            Progress = new Progress { CommandId = commandId, State = state, Percent = percent, Detail = detail },
        }).AsTask();

    public Task ReportResultAsync(CommandResult result) =>
        _comm.SendAsync(new AgentMessage { Result = result }).AsTask();

    public Task ReportEventAsync(string type, string severity, string payloadJson) =>
        _comm.SendAsync(new AgentMessage
        {
            Event = new Event { Type = type, Severity = severity, PayloadJson = payloadJson },
        }).AsTask();
}

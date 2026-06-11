using Ltsc.Agent.Comm;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Ltsc.Agent;

/// <summary>
/// Agent main loop (design §4.4): enroll, resume in-flight jobs, then hold the
/// DeviceLink stream open with reconnect/backoff while a timer emits heartbeats.
/// </summary>
public sealed class AgentService : BackgroundService
{
    private readonly CommChannel _comm;
    private readonly Orchestrator _orchestrator;
    private readonly AgentOptions _options;
    private readonly ILogger<AgentService> _log;

    public AgentService(CommChannel comm, Orchestrator orchestrator, AgentOptions options, ILogger<AgentService> log)
    {
        _comm = comm;
        _orchestrator = orchestrator;
        _options = options;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var facts = new DeviceFacts
        {
            HardwareUuid = _options.HardwareUuid,
            Model = _options.Model,
            OsBuild = Environment.OSVersion.VersionString,
            Arch = System.Runtime.InteropServices.RuntimeInformation.OSArchitecture.ToString(),
            AgentVersion = "0.1.0",
        };

        await _comm.EnsureEnrolledAsync(_options.EnrollmentToken, facts, ct);
        await _orchestrator.ResumeJobsAsync();

        // Reconcile config when the server signals drift (SyncPolicy), and once
        // at startup so the device converges without waiting for a push (§7).
        _comm.OnSyncPolicy = _ => ReconcileFromServerAsync(ct);
        await ReconcileFromServerAsync(ct);

        _ = Task.Run(() => HeartbeatLoop(ct), ct);

        // Reconnect with exponential backoff + jitter (design §4.4).
        var backoff = TimeSpan.FromSeconds(1);
        var max = TimeSpan.FromMinutes(5);
        while (!ct.IsCancellationRequested)
        {
            try
            {
                _log.LogInformation("Connecting DeviceLink stream...");
                await _comm.RunStreamAsync(ct);
                backoff = TimeSpan.FromSeconds(1);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                var jitter = TimeSpan.FromMilliseconds(Random.Shared.Next(0, 500));
                _log.LogWarning(ex, "Stream dropped; reconnecting in {Backoff}", backoff + jitter);
                await Task.Delay(backoff + jitter, ct);
                backoff = TimeSpan.FromSeconds(Math.Min(max.TotalSeconds, backoff.TotalSeconds * 2));
            }
        }
    }

    private async Task ReconcileFromServerAsync(CancellationToken ct)
    {
        try
        {
            var snapshot = await _comm.PullPolicyAsync(ct);
            await _orchestrator.ReconcilePolicyAsync(snapshot);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Policy reconcile failed");
        }
    }

    private async Task HeartbeatLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await _comm.SendAsync(new AgentMessage
            {
                Heartbeat = new Heartbeat
                {
                    AgentVersion = "0.1.0",
                    // Report the applied policy hash so the server can detect drift.
                    PolicyVersion = _orchestrator.Store.GetIdentity("policy_version") ?? "0",
                    Health = new Health { UwfEnabled = _orchestrator.Uwf.IsEnabled() },
                },
            });
            await Task.Delay(TimeSpan.FromSeconds(_options.HeartbeatSeconds), ct);
        }
    }
}

public sealed class AgentOptions
{
    public string ServerAddress { get; set; } = "http://localhost:8080";
    public string EnrollmentToken { get; set; } = "demo-token";
    public string HardwareUuid { get; set; } = "DEMO-" + Environment.MachineName;
    public string Model { get; set; } = "GenericThinClient";
    public string LocalStorePath { get; set; } = "agent-state.db";
    public int HeartbeatSeconds { get; set; } = 30;
}

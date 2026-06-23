using Google.Protobuf;
using Grpc.Core;
using Ltsc.Mgmt.V1;
using Ltsc.Server.Registry;

namespace Ltsc.Server.Services;

/// <summary>
/// Owns the bidirectional control stream (design §5). Reads agent heartbeats,
/// progress and results; writes server commands pulled from the device's
/// outbound channel. To make the loop observable, it asks the DemoCommandPusher
/// to enqueue a sample install command shortly after a device connects.
/// </summary>
public sealed class DeviceLinkService : DeviceLink.DeviceLinkBase
{
    private readonly ConnectionRegistry _connections;
    private readonly DeviceRegistry _devices;
    private readonly PolicyRegistry _policies;
    private readonly DemoCommandPusher _demo;
    private readonly InventoryStore _inventory;
    private readonly DeviceRouter _router;
    private readonly IPresence _presence;
    private readonly AgentRelease _release;
    private readonly AlertStore _alerts;
    private readonly Ca.CertAuthority _ca;
    private readonly ILogger<DeviceLinkService> _log;

    private readonly AppCatalog _catalog;
    private readonly CommandDispatcher _dispatcher;

    public DeviceLinkService(
        ConnectionRegistry connections,
        DeviceRegistry devices,
        PolicyRegistry policies,
        DemoCommandPusher demo,
        InventoryStore inventory,
        DeviceRouter router,
        IPresence presence,
        AgentRelease release,
        AlertStore alerts,
        AppCatalog catalog,
        CommandDispatcher dispatcher,
        Ca.CertAuthority ca,
        ILogger<DeviceLinkService> log)
    {
        _connections = connections;
        _devices = devices;
        _policies = policies;
        _demo = demo;
        _inventory = inventory;
        _router = router;
        _presence = presence;
        _release = release;
        _alerts = alerts;
        _catalog = catalog;
        _dispatcher = dispatcher;
        _ca = ca;
        _log = log;
    }

    /// <summary>Offer all apps assigned to this device's group (design §8/§12).</summary>
    private void DispatchAssignedApps(string deviceId)
    {
        if (!_devices.TryGet(deviceId, out var d)) return;
        foreach (var appId in _catalog.AssignedApps(d.TenantId, d.GroupId))
            if (_catalog.TryGet(d.TenantId, appId, out var pkg))
                _dispatcher.Dispatch(deviceId, "app", "install", pkg.Spec.ToByteString());
    }

    public override async Task Connect(
        IAsyncStreamReader<AgentMessage> requestStream,
        IServerStreamWriter<ServerMessage> responseStream,
        ServerCallContext context)
    {
        DeviceAuth.RequireDeviceCertificate(context, _ca);

        // The first message establishes the device id. The transport identity is
        // already proven by the validated client certificate above.
        if (!await requestStream.MoveNext(context.CancellationToken))
            return;

        var deviceId = requestStream.Current.DeviceId;
        if (string.IsNullOrEmpty(deviceId))
            throw new RpcException(new Status(StatusCode.InvalidArgument, "missing device_id"));

        var outbound = _connections.Connect(deviceId);
        _presence.Online(deviceId);   // publish presence (shared in Redis for multi-node)
        _log.LogInformation("Device {DeviceId} connected", deviceId);

        try
        {
            await responseStream.WriteAsync(new ServerMessage
            {
                Hello = new ServerHello
                {
                    HeartbeatIntervalSeconds = 30,
                    LatestAgentVersion = _release.Version,
                    AgentArtifactId = _release.ArtifactId,
                    AgentSha256 = _release.Sha256,
                    UpdateMandatory = _release.Mandatory,
                },
            });

            // Pump outbound server messages on a background task.
            var writer = Task.Run(async () =>
            {
                await foreach (var msg in outbound.ReadAllAsync(context.CancellationToken))
                    await responseStream.WriteAsync(msg);
            }, context.CancellationToken);

            // Tell the device to (re)reconcile its config policy + offer assigned apps.
            PushSyncPolicy(deviceId);
            DispatchAssignedApps(deviceId);

            // Queue a demo install once the device is online.
            _demo.ScheduleDemoInstall(deviceId);

            // Handle the first message, then continue reading.
            HandleAgentMessage(deviceId, requestStream.Current);
            while (await requestStream.MoveNext(context.CancellationToken))
                HandleAgentMessage(deviceId, requestStream.Current);

            await writer;
        }
        finally
        {
            _presence.Offline(deviceId);
            _connections.Disconnect(deviceId);
            _log.LogInformation("Device {DeviceId} disconnected", deviceId);
        }
    }

    private string TenantOf(string deviceId) => _devices.TryGet(deviceId, out var d) ? d.TenantId : "default";

    /// <summary>Zero-trust continuous posture: quarantine + alert on violation (design — zero trust).</summary>
    private void EvaluatePosture(string deviceId, Heartbeat hb)
    {
        if (!_devices.TryGet(deviceId, out var d)) return;
        var inPolicy = hb.PolicyVersion == ExpectedVersion(deviceId);
        var fails = _inventory.GetResults(deviceId).Count(r => r.Status is "Failed" or "RolledBack");
        var hs = FleetHealth.Score(true, DateTimeOffset.UtcNow, hb.Health, _inventory.GetInventory(deviceId), fails);
        var posture = Posture.Evaluate(hb.Health, inPolicy, hs);

        var wasQuarantined = d.Quarantined;
        _devices.Touch(deviceId, r => { r.Quarantined = !posture.Compliant; r.PostureViolations = posture.Violations; });
        if (!posture.Compliant && !wasQuarantined)
            _alerts.Add(new Alert(d.TenantId, deviceId, "error", "posture.violation",
                string.Join("; ", posture.Violations), DateTimeOffset.UtcNow));
    }

    private void HandleAgentMessage(string deviceId, AgentMessage msg)
    {
        switch (msg.PayloadCase)
        {
            case AgentMessage.PayloadOneofCase.Heartbeat:
                _devices.Touch(deviceId, r =>
                {
                    r.PolicyVersion = msg.Heartbeat.PolicyVersion;
                    r.RebootPending = msg.Heartbeat.Health?.RebootPending ?? false;
                });
                _log.LogDebug("Heartbeat from {DeviceId} (uwf={Uwf}, policy={Policy})",
                    deviceId, msg.Heartbeat.Health?.UwfEnabled, msg.Heartbeat.PolicyVersion);
                _inventory.SetHealth(deviceId, msg.Heartbeat.Health);
                if (AlertRules.FromHeartbeat(TenantOf(deviceId), deviceId, msg.Heartbeat.Health) is { } ha) _alerts.Add(ha);
                EvaluatePosture(deviceId, msg.Heartbeat);
                // Drift detection: nudge the device to reconcile if its applied
                // policy version doesn't match the effective one (design §7).
                if (msg.Heartbeat.PolicyVersion != ExpectedVersion(deviceId))
                    PushSyncPolicy(deviceId);
                break;

            case AgentMessage.PayloadOneofCase.Progress:
                _log.LogInformation("[{DeviceId}] {Cmd} -> {State} {Pct}% {Detail}",
                    deviceId, msg.Progress.CommandId, msg.Progress.State,
                    msg.Progress.Percent, msg.Progress.Detail);
                break;

            case AgentMessage.PayloadOneofCase.Result:
                _inventory.AddResult(deviceId, msg.Result);
                if (AlertRules.FromResult(TenantOf(deviceId), deviceId, msg.Result) is { } ra) _alerts.Add(ra);
                _log.LogInformation("[{DeviceId}] {Cmd} RESULT status={Status} exit={Exit} reboot={Reboot} uwf_reenabled={Uwf}",
                    deviceId, msg.Result.CommandId, msg.Result.Status,
                    msg.Result.ExitCode, msg.Result.RebootState, msg.Result.UwfReenabled);
                break;

            case AgentMessage.PayloadOneofCase.InventoryReport:
                _inventory.SetInventory(deviceId, msg.InventoryReport);
                _log.LogInformation("[{DeviceId}] INVENTORY host={Host} os={Os} cpu={Cpu} mem={Mem}MB apps={Apps}",
                    deviceId, msg.InventoryReport.Hostname, msg.InventoryReport.OsBuild,
                    msg.InventoryReport.CpuCount, msg.InventoryReport.TotalMemoryBytes / (1024 * 1024),
                    msg.InventoryReport.Apps.Count);
                break;

            case AgentMessage.PayloadOneofCase.Event:
                if (AlertRules.FromEvent(TenantOf(deviceId), deviceId, msg.Event) is { } ea) _alerts.Add(ea);
                _log.LogInformation("[{DeviceId}] EVENT {Type}/{Sev}: {Payload}",
                    deviceId, msg.Event.Type, msg.Event.Severity, msg.Event.PayloadJson);
                break;
        }
    }

    private string ExpectedVersion(string deviceId)
    {
        if (!_devices.TryGet(deviceId, out var dev)) return "0";
        return _policies.ForGroup(dev.TenantId, dev.GroupId).ContentHash;
    }

    private void PushSyncPolicy(string deviceId) =>
        _router.Send(deviceId, new ServerMessage
        {
            Sync = new SyncPolicy { ExpectedPolicyVersion = ExpectedVersion(deviceId) },
        });
}

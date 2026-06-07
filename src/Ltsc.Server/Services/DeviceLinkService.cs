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
    private readonly DemoCommandPusher _demo;
    private readonly ILogger<DeviceLinkService> _log;

    public DeviceLinkService(
        ConnectionRegistry connections,
        DeviceRegistry devices,
        DemoCommandPusher demo,
        ILogger<DeviceLinkService> log)
    {
        _connections = connections;
        _devices = devices;
        _demo = demo;
        _log = log;
    }

    public override async Task Connect(
        IAsyncStreamReader<AgentMessage> requestStream,
        IServerStreamWriter<ServerMessage> responseStream,
        ServerCallContext context)
    {
        // The first message establishes the device id (in production this comes
        // from the validated client certificate, not the payload).
        if (!await requestStream.MoveNext(context.CancellationToken))
            return;

        var deviceId = requestStream.Current.DeviceId;
        if (string.IsNullOrEmpty(deviceId))
            throw new RpcException(new Status(StatusCode.InvalidArgument, "missing device_id"));

        var outbound = _connections.Connect(deviceId);
        _log.LogInformation("Device {DeviceId} connected", deviceId);

        try
        {
            await responseStream.WriteAsync(new ServerMessage
            {
                Hello = new ServerHello { HeartbeatIntervalSeconds = 30 },
            });

            // Pump outbound server messages on a background task.
            var writer = Task.Run(async () =>
            {
                await foreach (var msg in outbound.ReadAllAsync(context.CancellationToken))
                    await responseStream.WriteAsync(msg);
            }, context.CancellationToken);

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
            _connections.Disconnect(deviceId);
            _log.LogInformation("Device {DeviceId} disconnected", deviceId);
        }
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
                _log.LogDebug("Heartbeat from {DeviceId} (uwf={Uwf})",
                    deviceId, msg.Heartbeat.Health?.UwfEnabled);
                break;

            case AgentMessage.PayloadOneofCase.Progress:
                _log.LogInformation("[{DeviceId}] {Cmd} -> {State} {Pct}% {Detail}",
                    deviceId, msg.Progress.CommandId, msg.Progress.State,
                    msg.Progress.Percent, msg.Progress.Detail);
                break;

            case AgentMessage.PayloadOneofCase.Result:
                _log.LogInformation("[{DeviceId}] {Cmd} RESULT status={Status} exit={Exit} reboot={Reboot} uwf_reenabled={Uwf}",
                    deviceId, msg.Result.CommandId, msg.Result.Status,
                    msg.Result.ExitCode, msg.Result.RebootState, msg.Result.UwfReenabled);
                break;

            case AgentMessage.PayloadOneofCase.Event:
                _log.LogInformation("[{DeviceId}] EVENT {Type}/{Sev}: {Payload}",
                    deviceId, msg.Event.Type, msg.Event.Severity, msg.Event.PayloadJson);
                break;
        }
    }
}

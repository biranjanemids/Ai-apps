using System.Threading.Channels;
using Grpc.Core;
using Grpc.Net.Client;
using Ltsc.Agent.Storage;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging;

namespace Ltsc.Agent.Comm;

/// <summary>
/// gRPC link to the MgmtServer (design §4.2, §5): enrollment, the long-lived
/// DeviceLink bidi stream, an outbox for agent->server messages, and dispatch of
/// inbound commands. Production uses mTLS with the device certificate; this
/// scaffold uses h2c + a session token in metadata.
/// </summary>
public sealed class CommChannel : IAsyncDisposable
{
    private readonly GrpcChannel _channel;
    private readonly LocalStore _store;
    private readonly ILogger<CommChannel> _log;
    private readonly Channel<AgentMessage> _outbox =
        Channel.CreateUnbounded<AgentMessage>(new UnboundedChannelOptions { SingleReader = true });

    public string DeviceId { get; private set; } = "";
    public Func<CommandEnvelope, Task>? OnCommand { get; set; }
    public Func<string, Task>? OnSyncPolicy { get; set; }   // arg = server's expected policy version

    public CommChannel(string serverAddress, LocalStore store, ILogger<CommChannel> log)
    {
        _store = store;
        _log = log;
        // AppContext switch enables h2c (cleartext HTTP/2) for the local demo.
        AppContext.SetSwitch("System.Net.Http.SocketsHttpHandler.Http2UnencryptedSupport", true);
        _channel = GrpcChannel.ForAddress(serverAddress);
    }

    public async Task EnsureEnrolledAsync(string enrollmentToken, DeviceFacts facts, CancellationToken ct)
    {
        DeviceId = _store.GetIdentity("device_id") ?? "";
        if (!string.IsNullOrEmpty(DeviceId))
        {
            _log.LogInformation("Already enrolled as {DeviceId}", DeviceId);
            return;
        }

        var client = new Enrollment.EnrollmentClient(_channel);
        var resp = await client.EnrollAsync(new EnrollRequest
        {
            EnrollmentToken = enrollmentToken,
            Facts = facts,
        }, cancellationToken: ct);

        DeviceId = resp.DeviceId;
        _store.SetIdentity("device_id", resp.DeviceId);
        _store.SetIdentity("group_id", resp.GroupId);
        _store.SetIdentity("session_token", resp.SessionToken);
        _log.LogInformation("Enrolled as {DeviceId} in {Group}", resp.DeviceId, resp.GroupId);
    }

    /// <summary>Enqueue a message for the server (buffered when offline).</summary>
    public ValueTask SendAsync(AgentMessage msg) => _outbox.Writer.WriteAsync(msg);

    /// <summary>Pull the effective desired-state policy snapshot for this device (design §7).</summary>
    public async Task<PolicySnapshot> PullPolicyAsync(CancellationToken ct)
    {
        var client = new PolicyService.PolicyServiceClient(_channel);
        var metadata = new Metadata { { "x-session-token", _store.GetIdentity("session_token") ?? "" } };
        return await client.GetPolicyAsync(new GetPolicyRequest { DeviceId = DeviceId }, metadata, cancellationToken: ct);
    }

    /// <summary>
    /// Open the bidi stream and pump both directions until cancelled/faulted.
    /// The caller wraps this in a reconnect-with-backoff loop.
    /// </summary>
    public async Task RunStreamAsync(CancellationToken ct)
    {
        var client = new DeviceLink.DeviceLinkClient(_channel);
        var metadata = new Metadata { { "x-session-token", _store.GetIdentity("session_token") ?? "" } };
        using var call = client.Connect(metadata, cancellationToken: ct);

        // Stops the outbound pump when the inbound stream ends, without
        // completing the shared outbox (it must survive across reconnects).
        using var link = CancellationTokenSource.CreateLinkedTokenSource(ct);

        // Identify the device on the first frame.
        await call.RequestStream.WriteAsync(new AgentMessage { DeviceId = DeviceId });

        var writer = Task.Run(async () =>
        {
            try
            {
                await foreach (var msg in _outbox.Reader.ReadAllAsync(link.Token))
                {
                    msg.DeviceId = DeviceId;
                    await call.RequestStream.WriteAsync(msg);
                }
            }
            catch (OperationCanceledException) { /* stream ended; messages stay buffered */ }
        }, link.Token);

        try
        {
            await foreach (var server in call.ResponseStream.ReadAllAsync(ct))
            {
                switch (server.PayloadCase)
                {
                    case ServerMessage.PayloadOneofCase.Hello:
                        _log.LogInformation("ServerHello: heartbeat every {N}s", server.Hello.HeartbeatIntervalSeconds);
                        break;
                    case ServerMessage.PayloadOneofCase.Command:
                        if (OnCommand is not null) _ = OnCommand(server.Command);
                        break;
                    case ServerMessage.PayloadOneofCase.Sync:
                        if (OnSyncPolicy is not null) _ = OnSyncPolicy(server.Sync.ExpectedPolicyVersion);
                        break;
                }
            }
        }
        finally
        {
            link.Cancel();
            await writer;
        }
    }

    public async ValueTask DisposeAsync()
    {
        _outbox.Writer.TryComplete();
        await _channel.ShutdownAsync();
    }
}

using Google.Protobuf;
using Ltsc.Mgmt.V1;
using StackExchange.Redis;

namespace Ltsc.Server.Registry;

/// <summary>
/// Redis-backed presence + command relay for multi-node operation (design §12.2).
///  - presence: `presence:{deviceId}` = nodeId, refreshed with a TTL while the
///    device's stream is held locally; any node can check IsOnline fleet-wide.
///  - routing: CommandDispatcher publishes to `dev:{deviceId}`; the node holding
///    the stream is subscribed and writes the message onto the local channel.
/// This lets any node command any device without knowing which node owns the
/// socket — the same role NATS plays in the design.
/// </summary>
public sealed class RedisPresence : IPresence, IAsyncDisposable
{
    private readonly ConnectionMultiplexer _redis;
    private readonly IDatabase _db;
    private readonly ConnectionRegistry _connections;
    private readonly string _nodeId = Environment.MachineName + ":" + Guid.NewGuid().ToString("n")[..6];
    private static readonly TimeSpan Ttl = TimeSpan.FromSeconds(60);

    public RedisPresence(string configuration, ConnectionRegistry connections)
    {
        _redis = ConnectionMultiplexer.Connect(configuration);
        _db = _redis.GetDatabase();
        _connections = connections;
    }

    public void Online(string deviceId)
    {
        _db.StringSet($"presence:{deviceId}", _nodeId, Ttl);
        // Subscribe this node to the device's command channel; relay to the local stream.
        _redis.GetSubscriber().Subscribe(RedisChannel.Literal($"dev:{deviceId}"), (_, val) =>
        {
            if (val.IsNullOrEmpty) return;
            var msg = ServerMessage.Parser.ParseFrom((byte[])val!);
            _connections.Send(deviceId, msg);
        });
    }

    public void Offline(string deviceId)
    {
        _db.KeyDelete($"presence:{deviceId}");
        _redis.GetSubscriber().Unsubscribe(RedisChannel.Literal($"dev:{deviceId}"));
    }

    public bool IsOnline(string deviceId) => _db.KeyExists($"presence:{deviceId}");

    /// <summary>Routes a command to whichever node holds the device's stream.</summary>
    public long Publish(string deviceId, ServerMessage message) =>
        _db.Publish(RedisChannel.Literal($"dev:{deviceId}"), message.ToByteArray());

    public bool IsDeviceKnown(string deviceId) => IsOnline(deviceId);

    public async ValueTask DisposeAsync() => await _redis.DisposeAsync();
}

namespace Ltsc.Server.Registry;

/// <summary>
/// Cross-node device presence + command routing (design §12.2). In a single-node
/// deployment the in-process implementation is exact; for multi-node, the Redis
/// implementation shares presence and relays commands so any node can reach a
/// device whose stream is held by another node (NATS is an interchangeable bus).
/// </summary>
public interface IPresence
{
    void Online(string deviceId);
    void Offline(string deviceId);
    bool IsOnline(string deviceId);
}

/// <summary>Default: presence == "has a local stream" (ConnectionRegistry).</summary>
public sealed class InProcessPresence : IPresence
{
    private readonly ConnectionRegistry _connections;
    public InProcessPresence(ConnectionRegistry connections) => _connections = connections;
    public void Online(string deviceId) { }
    public void Offline(string deviceId) { }
    public bool IsOnline(string deviceId) => _connections.IsOnline(deviceId);
}

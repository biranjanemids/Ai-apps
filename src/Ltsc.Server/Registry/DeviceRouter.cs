using Ltsc.Mgmt.V1;

namespace Ltsc.Server.Registry;

/// <summary>
/// Routes a server message to a device regardless of which node holds its stream
/// (design §12.2). In-process: writes the local channel directly. Redis: publishes
/// to the device's channel so the owning node relays it. Presence likewise comes
/// from the shared store when Redis is enabled, so IsOnline is fleet-wide.
/// </summary>
public sealed class DeviceRouter
{
    private readonly ConnectionRegistry _connections;
    private readonly IPresence _presence;

    public DeviceRouter(ConnectionRegistry connections, IPresence presence)
    {
        _connections = connections;
        _presence = presence;
    }

    public bool IsOnline(string deviceId) => _presence.IsOnline(deviceId);

    public bool Send(string deviceId, ServerMessage message)
    {
        if (_presence is RedisPresence redis)
            return redis.Publish(deviceId, message) > 0;   // relayed to the owning node
        return _connections.Send(deviceId, message);        // single-node: straight to the stream
    }
}

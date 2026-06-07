using System.Collections.Concurrent;
using System.Threading.Channels;
using Ltsc.Mgmt.V1;

namespace Ltsc.Server.Registry;

/// <summary>
/// Maps an online device to the queue feeding its open DeviceLink stream.
/// In production (design §12.2) this is a Redis map of device_id -> ingress pod
/// plus a NATS subject per device, so any service can reach any device without
/// knowing which pod holds the socket. Here it is a per-process channel map.
/// </summary>
public sealed class ConnectionRegistry
{
    private readonly ConcurrentDictionary<string, Channel<ServerMessage>> _outbound = new();

    /// <summary>Registers a device as online and returns its outbound reader.</summary>
    public ChannelReader<ServerMessage> Connect(string deviceId)
    {
        var channel = Channel.CreateUnbounded<ServerMessage>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false,
        });
        _outbound[deviceId] = channel;
        return channel.Reader;
    }

    public void Disconnect(string deviceId)
    {
        if (_outbound.TryRemove(deviceId, out var channel))
            channel.Writer.TryComplete();
    }

    public bool IsOnline(string deviceId) => _outbound.ContainsKey(deviceId);

    /// <summary>Pushes a server message onto a device's stream. Returns false if offline.</summary>
    public bool Send(string deviceId, ServerMessage message) =>
        _outbound.TryGetValue(deviceId, out var channel) && channel.Writer.TryWrite(message);

    public IReadOnlyCollection<string> OnlineDevices() => _outbound.Keys.ToArray();
}

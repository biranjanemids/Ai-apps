using System.Collections.Concurrent;
using Ltsc.Mgmt.V1;

namespace Ltsc.Server.Registry;

/// <summary>
/// Device + group state, write-through persisted to <see cref="ServerStore"/>
/// (SQLite) so the fleet survives a server restart. The design (§12.3) swaps
/// the storage layer for PostgreSQL in multi-node deployments.
/// </summary>
public sealed class DeviceRegistry
{
    public sealed record DeviceRecord(
        string DeviceId,
        string GroupId,
        DeviceFacts Facts,
        DateTimeOffset EnrolledAt)
    {
        public DateTimeOffset LastSeen { get; set; } = DateTimeOffset.UtcNow;
        public string PolicyVersion { get; set; } = "";
        public bool RebootPending { get; set; }
    }

    private readonly ConcurrentDictionary<string, DeviceRecord> _devices = new();
    private readonly IServerStore? _store;

    public DeviceRegistry(IServerStore? store = null)
    {
        _store = store;
        if (store is not null)
            foreach (var rec in store.LoadDevices())
                _devices[rec.DeviceId] = rec;
    }

    public DeviceRecord Enroll(DeviceFacts facts, string groupId, string certThumbprint = "")
    {
        // Stable device id derived from hardware uuid so re-enroll is idempotent.
        var id = string.IsNullOrWhiteSpace(facts.HardwareUuid)
            ? Guid.NewGuid().ToString("n")
            : facts.HardwareUuid;

        var record = new DeviceRecord(id, groupId, facts, DateTimeOffset.UtcNow);
        _devices[id] = record;
        _store?.UpsertDevice(record, certThumbprint);
        return record;
    }

    public bool TryGet(string deviceId, out DeviceRecord record) =>
        _devices.TryGetValue(deviceId, out record!);

    public void Touch(string deviceId, Action<DeviceRecord> update)
    {
        if (_devices.TryGetValue(deviceId, out var rec))
        {
            rec.LastSeen = DateTimeOffset.UtcNow;
            update(rec);
            _store?.UpsertDevice(rec);
        }
    }

    public IReadOnlyCollection<DeviceRecord> All() => _devices.Values.ToArray();
}

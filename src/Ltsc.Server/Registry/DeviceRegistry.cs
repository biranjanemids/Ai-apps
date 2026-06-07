using System.Collections.Concurrent;
using Ltsc.Mgmt.V1;

namespace Ltsc.Server.Registry;

/// <summary>
/// In-memory device + group state. The design (§12.3) backs this with
/// PostgreSQL; this scaffold keeps it in-process so the loop runs with no
/// external dependencies. Swap for an EF Core repository later.
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

    public DeviceRecord Enroll(DeviceFacts facts, string groupId)
    {
        // Stable device id derived from hardware uuid so re-enroll is idempotent.
        var id = string.IsNullOrWhiteSpace(facts.HardwareUuid)
            ? Guid.NewGuid().ToString("n")
            : facts.HardwareUuid;

        var record = new DeviceRecord(id, groupId, facts, DateTimeOffset.UtcNow);
        _devices[id] = record;
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
        }
    }

    public IReadOnlyCollection<DeviceRecord> All() => _devices.Values.ToArray();
}

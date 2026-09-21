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
        public string TenantId { get; init; } = "default";
        public string CertThumbprint { get; set; } = "";
        public DateTimeOffset LastSeen { get; set; } = DateTimeOffset.UtcNow;
        public string PolicyVersion { get; set; } = "";
        public bool RebootPending { get; set; }
        public bool Quarantined { get; set; }            // zero-trust posture violation
        public IReadOnlyList<string> PostureViolations { get; set; } = Array.Empty<string>();
    }

    private readonly ConcurrentDictionary<string, DeviceRecord> _devices = new();
    private readonly ConcurrentDictionary<string, byte> _dirty = new();
    private readonly IServerStore? _store;

    public DeviceRegistry(IServerStore? store = null)
    {
        _store = store;
        if (store is not null)
            foreach (var rec in store.LoadDevices())
                _devices[rec.DeviceId] = rec;
    }

    public DeviceRecord Enroll(DeviceFacts facts, string tenantId, string groupId, string certThumbprint = "")
    {
        // Stable device id derived from hardware uuid so re-enroll is idempotent.
        var id = string.IsNullOrWhiteSpace(facts.HardwareUuid)
            ? Guid.NewGuid().ToString("n")
            : facts.HardwareUuid;

        var record = new DeviceRecord(id, groupId, facts, DateTimeOffset.UtcNow) { TenantId = tenantId, CertThumbprint = certThumbprint };
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
            // Write-behind: heartbeats arrive at fleet scale (N devices / interval).
            // Persisting each one synchronously serialises the whole control plane
            // behind the store lock, so mark dirty and let the flusher batch it.
            // Enrollment stays synchronous — identity must be durable immediately.
            _dirty[deviceId] = 0;
        }
    }

    /// <summary>Persists devices touched since the last flush. Returns the count written.</summary>
    public int FlushDirty()
    {
        if (_store is null) { _dirty.Clear(); return 0; }
        var written = 0;
        foreach (var id in _dirty.Keys)
        {
            if (!_dirty.TryRemove(id, out _)) continue;
            if (_devices.TryGetValue(id, out var rec)) { _store.UpsertDevice(rec); written++; }
        }
        return written;
    }

    public IReadOnlyCollection<DeviceRecord> All() => _devices.Values.ToArray();

    /// <summary>Devices belonging to one tenant (multi-tenant isolation, design §12).</summary>
    public IReadOnlyCollection<DeviceRecord> ForTenant(string tenantId) =>
        _devices.Values.Where(d => d.TenantId == tenantId).ToArray();
}

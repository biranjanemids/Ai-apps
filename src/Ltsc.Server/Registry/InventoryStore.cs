using System.Collections.Concurrent;
using Ltsc.Mgmt.V1;

namespace Ltsc.Server.Registry;

/// <summary>Latest inventory report + recent command results per device (design §10).</summary>
public sealed class InventoryStore
{
    private readonly ConcurrentDictionary<string, InventoryReport> _inventory = new();
    private readonly ConcurrentDictionary<string, Health> _health = new();
    private readonly ConcurrentDictionary<string, List<CommandResult>> _results = new();

    public void SetInventory(string deviceId, InventoryReport report) => _inventory[deviceId] = report;
    public InventoryReport? GetInventory(string deviceId) => _inventory.TryGetValue(deviceId, out var r) ? r : null;

    public void SetHealth(string deviceId, Health? h) { if (h is not null) _health[deviceId] = h; }
    public Health? GetHealth(string deviceId) => _health.TryGetValue(deviceId, out var h) ? h : null;

    public void AddResult(string deviceId, CommandResult result)
    {
        var list = _results.GetOrAdd(deviceId, _ => new List<CommandResult>());
        lock (list)
        {
            list.Insert(0, result);
            if (list.Count > 50) list.RemoveRange(50, list.Count - 50);
        }
    }

    public IReadOnlyList<CommandResult> GetResults(string deviceId)
    {
        if (!_results.TryGetValue(deviceId, out var list)) return Array.Empty<CommandResult>();
        lock (list) return list.ToArray();
    }
}

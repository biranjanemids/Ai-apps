using System.Collections.Concurrent;
using Ltsc.Mgmt.V1;

namespace Ltsc.Server.Registry;

/// <summary>
/// App-package catalog + per-(tenant, group) assignments (design §8/§12). Admins
/// register an InstallSpec-backed package and assign it to a group; the server
/// dispatches the install to the group's online devices and offers it to devices
/// that come online later. In-memory here (mirrors the design's PackageService);
/// production persists to the object store + DB.
/// </summary>
public sealed class AppCatalog
{
    public sealed record Package(string Tenant, string AppId, string Version, InstallSpec Spec);

    // tenant -> appId -> package
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, Package>> _packages = new();
    // tenant/group -> set of appIds
    private readonly ConcurrentDictionary<string, HashSet<string>> _assignments = new();

    private static string GK(string tenant, string group) => $"{tenant}/{group}";

    public Package Register(string tenant, string appId, string version, InstallSpec spec)
    {
        var pkg = new Package(tenant, appId, version, spec);
        _packages.GetOrAdd(tenant, _ => new())[appId] = pkg;
        return pkg;
    }

    public IReadOnlyList<Package> ForTenant(string tenant) =>
        _packages.TryGetValue(tenant, out var m) ? m.Values.ToArray() : Array.Empty<Package>();

    public bool TryGet(string tenant, string appId, out Package pkg)
    {
        pkg = default!;
        return _packages.TryGetValue(tenant, out var m) && m.TryGetValue(appId, out pkg!);
    }

    public void Assign(string tenant, string group, string appId)
    {
        var set = _assignments.GetOrAdd(GK(tenant, group), _ => new());
        lock (set) set.Add(appId);
    }

    public IReadOnlyList<string> AssignedApps(string tenant, string group) =>
        _assignments.TryGetValue(GK(tenant, group), out var s)
            ? (lockCopy(s)) : Array.Empty<string>();

    private static string[] lockCopy(HashSet<string> s) { lock (s) return s.ToArray(); }
}

using System.Collections.Concurrent;
using System.Security.Cryptography;
using Google.Protobuf;
using Ltsc.Mgmt.V1;

namespace Ltsc.Server.Registry;

/// <summary>
/// Effective per-group policy (design §7/§12), now authored at runtime via the
/// console and persisted to <see cref="ServerStore"/>. Setting a group's policy
/// bumps its version and content hash so devices detect drift and re-reconcile.
/// </summary>
public sealed class PolicyRegistry
{
    private readonly ConcurrentDictionary<string, PolicySnapshot> _byGroup = new();
    private readonly ServerStore? _store;

    public PolicyRegistry(ServerStore? store = null)
    {
        _store = store;
        if (store is not null)
            foreach (var (group, json) in store.LoadPolicies())
                _byGroup[group] = JsonParser.Default.Parse<PolicySnapshot>(json);

        _byGroup.GetOrAdd("group-default", _ => BuildDemo());
    }

    public PolicySnapshot ForGroup(string groupId) =>
        _byGroup.TryGetValue(groupId, out var s) ? s : new PolicySnapshot { Version = "0", ContentHash = "0" };

    public IEnumerable<string> Groups => _byGroup.Keys;

    /// <summary>Author a group's policy: re-version, re-hash, persist. Returns the new snapshot.</summary>
    public PolicySnapshot SetGroupPolicy(string groupId, PolicySnapshot snapshot)
    {
        var next = snapshot.Clone();
        var prevVersion = _byGroup.TryGetValue(groupId, out var prev) && int.TryParse(prev.Version, out var v) ? v : 0;
        next.Version = (prevVersion + 1).ToString();
        next.ContentHash = Hash(next);
        _byGroup[groupId] = next;
        _store?.UpsertPolicy(groupId, JsonFormatter.Default.Format(next));
        return next;
    }

    private static PolicySnapshot BuildDemo()
    {
        var snap = new PolicySnapshot { Version = "1" };
        snap.Profiles.Add(new ConfigProfile
        {
            ProfileId = "reg-baseline",
            Registry = new RegistryProfile
            {
                Values = { new RegValue { Hive = "HKLM", Path = @"Software\Contoso\Kiosk", Name = "Brand", Type = "sz", Data = "Contoso" } },
            },
        });
        snap.Profiles.Add(new ConfigProfile
        {
            ProfileId = "uwf-on",
            Uwf = new UwfProfile2 { Enabled = true, FileExclusions = { @"C:\ProgramData\Ltsc" }, OverlayWarnBytes = 1L << 30 },
        });
        snap.Profiles.Add(new ConfigProfile
        {
            ProfileId = "kiosk-shell",
            Kiosk = new KioskProfile { Mode = "shell_launcher", ShellExe = @"C:\Kiosk\app.exe", AutoLogonUser = "kioskuser" },
        });
        snap.ContentHash = Hash(snap);
        return snap;
    }

    public static string Hash(PolicySnapshot snap)
    {
        var copy = snap.Clone();
        copy.ContentHash = "";
        return Convert.ToHexString(SHA256.HashData(copy.ToByteArray()))[..16];
    }
}

using System.Collections.Concurrent;
using System.Security.Cryptography;
using Google.Protobuf;
using Ltsc.Mgmt.V1;

namespace Ltsc.Server.Registry;

/// <summary>
/// Effective per-(tenant, group) policy (design §7/§12). Multi-tenant: every
/// snapshot is keyed by tenant so one tenant's policy never resolves for another.
/// Authored at runtime via the console and persisted to <see cref="IServerStore"/>;
/// setting a group's policy bumps its version + content hash so devices detect
/// drift and re-reconcile.
/// </summary>
public sealed class PolicyRegistry
{
    private readonly ConcurrentDictionary<string, PolicySnapshot> _byKey = new(); // key: tenant/group
    private readonly IServerStore? _store;

    private static string Key(string tenant, string group) => $"{tenant}/{group}";

    public PolicyRegistry(IServerStore? store = null)
    {
        _store = store;
        if (store is not null)
            foreach (var (tenant, group, json) in store.LoadPolicies())
                _byKey[Key(tenant, group)] = JsonParser.Default.Parse<PolicySnapshot>(json);

        // Seed a demo policy per demo tenant so the reconcile loop is observable.
        _byKey.GetOrAdd(Key("tenant-a", "group-default"), _ => BuildDemo("Contoso"));
        _byKey.GetOrAdd(Key("tenant-b", "group-default"), _ => BuildDemo("Acme"));
    }

    public PolicySnapshot ForGroup(string tenant, string group) =>
        _byKey.TryGetValue(Key(tenant, group), out var s) ? s : new PolicySnapshot { Version = "0", ContentHash = "0" };

    /// <summary>Author a (tenant, group) policy: re-version, re-hash, persist.</summary>
    public PolicySnapshot SetGroupPolicy(string tenant, string group, PolicySnapshot snapshot)
    {
        var next = snapshot.Clone();
        var prevVersion = _byKey.TryGetValue(Key(tenant, group), out var prev) && int.TryParse(prev.Version, out var v) ? v : 0;
        next.Version = (prevVersion + 1).ToString();
        next.ContentHash = Hash(next);
        _byKey[Key(tenant, group)] = next;
        _store?.UpsertPolicy(tenant, group, JsonFormatter.Default.Format(next));
        return next;
    }

    private static PolicySnapshot BuildDemo(string brand)
    {
        var snap = new PolicySnapshot { Version = "1" };
        snap.Profiles.Add(new ConfigProfile
        {
            ProfileId = "reg-baseline",
            Registry = new RegistryProfile
            {
                Values = { new RegValue { Hive = "HKLM", Path = @"Software\Contoso\Kiosk", Name = "Brand", Type = "sz", Data = brand } },
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

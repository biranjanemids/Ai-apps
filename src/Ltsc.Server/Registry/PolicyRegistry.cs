using System.Security.Cryptography;
using Google.Protobuf;
using Ltsc.Mgmt.V1;

namespace Ltsc.Server.Registry;

/// <summary>
/// In-memory effective-policy store (design §7, §12). Production resolves the
/// per-device snapshot from the group tree in PostgreSQL; this scaffold seeds one
/// demo snapshot per group so the reconcile loop is observable end-to-end.
/// </summary>
public sealed class PolicyRegistry
{
    private readonly Dictionary<string, PolicySnapshot> _byGroup = new();

    public PolicyRegistry()
    {
        _byGroup["group-default"] = BuildDemo();
    }

    public PolicySnapshot ForGroup(string groupId) =>
        _byGroup.TryGetValue(groupId, out var s) ? s : new PolicySnapshot { Version = "0", ContentHash = "0" };

    private static PolicySnapshot BuildDemo()
    {
        var snap = new PolicySnapshot { Version = "1" };

        snap.Profiles.Add(new ConfigProfile
        {
            ProfileId = "reg-baseline",
            Registry = new RegistryProfile
            {
                Values =
                {
                    new RegValue { Hive = "HKLM", Path = @"Software\Contoso\Kiosk", Name = "Brand", Type = "sz", Data = "Contoso" },
                },
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

    /// <summary>Stable hash over the profiles (excluding the hash field itself).</summary>
    public static string Hash(PolicySnapshot snap)
    {
        var copy = snap.Clone();
        copy.ContentHash = "";
        return Convert.ToHexString(SHA256.HashData(copy.ToByteArray()))[..16];
    }
}

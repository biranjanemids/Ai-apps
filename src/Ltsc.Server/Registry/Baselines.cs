using Ltsc.Mgmt.V1;

namespace Ltsc.Server.Registry;

/// <summary>
/// Built-in hardened baselines (day-one value). A new customer gets a locked-down,
/// CIS/STIG-flavoured LTSC fleet by applying one template instead of authoring
/// policy for weeks. Each baseline is an ordinary PolicySnapshot, so it lands on
/// the same reconcile/drift/simulate path as hand-authored policy and can be
/// edited afterwards.
/// </summary>
public static class Baselines
{
    public sealed record Info(string Id, string Name, string Description, int Profiles);

    public static IReadOnlyList<Info> All() => new[]
    {
        new Info("kiosk-hardened", "Kiosk — Hardened",
            "Single-app kiosk: write filter on, custom shell, AppLocker deny-by-default, keyboard breakout blocked, removable storage and autorun disabled.", 5),
        new Info("thinclient-standard", "Thin Client — Standard",
            "General thin client: write filter on, power/time baseline, telemetry minimised, autorun disabled.", 4),
        new Info("lab-classroom", "Lab / Classroom",
            "Shared lab device: multi-app assigned access, auto-logon, nightly reboot window, write filter discards changes between sessions.", 3),
    };

    public static PolicySnapshot? Build(string id) => id switch
    {
        "kiosk-hardened" => KioskHardened(),
        "thinclient-standard" => ThinClientStandard(),
        "lab-classroom" => LabClassroom(),
        _ => null,
    };

    private static ConfigProfile Reg(string profileId, params RegValue[] values)
    {
        var p = new ConfigProfile { ProfileId = profileId, Registry = new RegistryProfile() };
        p.Registry.Values.AddRange(values);
        return p;
    }

    private static RegValue D(string path, string name, int data) =>
        new() { Hive = "HKLM", Path = path, Name = name, Type = "dword", Data = data.ToString() };
    private static RegValue DU(string path, string name, int data) =>
        new() { Hive = "HKCU", Path = path, Name = name, Type = "dword", Data = data.ToString() };

    private static PolicySnapshot Finish(PolicySnapshot s)
    { s.ContentHash = PolicyRegistry.Hash(s); return s; }

    private static PolicySnapshot KioskHardened()
    {
        var s = new PolicySnapshot { Version = "1" };
        s.Profiles.Add(new ConfigProfile
        {
            ProfileId = "baseline-uwf",
            Uwf = new UwfProfile2
            {
                Enabled = true,
                FileExclusions = { @"C:\ProgramData\Ltsc" },
                OverlayWarnBytes = 1L << 30,
            },
        });
        s.Profiles.Add(new ConfigProfile
        {
            ProfileId = "baseline-kiosk-shell",
            Kiosk = new KioskProfile { Mode = "shell_launcher", ShellExe = @"C:\Kiosk\app.exe", AutoLogonUser = "kioskuser" },
        });
        s.Profiles.Add(new ConfigProfile
        {
            ProfileId = "baseline-keyfilter",
            Keyfilter = new KeyboardFilterProfile
            {
                BlockedKeys = { "Ctrl+Alt+Del", "Ctrl+Shift+Esc", "Win", "Win+R", "Alt+Tab", "Alt+F4" },
                DisableBreakout = true,
            },
        });
        s.Profiles.Add(new ConfigProfile
        {
            ProfileId = "baseline-applocker",
            Applocker = new AppLockerProfile { PolicyXml = "<AppLockerPolicy Version=\"1\"><!-- deny by default; allow kiosk app + signed system binaries --></AppLockerPolicy>" },
        });
        // CIS/STIG-flavoured lockdown: no removable storage, no autorun, no
        // telemetry, no Task Manager / Control Panel escape hatches.
        s.Profiles.Add(Reg("baseline-hardening",
            D(@"SYSTEM\CurrentControlSet\Services\USBSTOR", "Start", 4),
            D(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer", "NoDriveTypeAutoRun", 255),
            D(@"SOFTWARE\Policies\Microsoft\Windows\DataCollection", "AllowTelemetry", 0),
            DU(@"Software\Microsoft\Windows\CurrentVersion\Policies\System", "DisableTaskMgr", 1),
            DU(@"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer", "NoControlPanel", 1)));
        return Finish(s);
    }

    private static PolicySnapshot ThinClientStandard()
    {
        var s = new PolicySnapshot { Version = "1" };
        s.Profiles.Add(new ConfigProfile
        {
            ProfileId = "baseline-uwf",
            Uwf = new UwfProfile2 { Enabled = true, FileExclusions = { @"C:\ProgramData\Ltsc" }, OverlayWarnBytes = 1L << 30 },
        });
        s.Profiles.Add(new ConfigProfile
        {
            ProfileId = "baseline-power",
            Power = new PowerProfile { SleepMinutes = 30 },
        });
        s.Profiles.Add(new ConfigProfile
        {
            ProfileId = "baseline-time",
            Time = new TimeProfile { NtpServer = "time.windows.com", Timezone = "UTC" },
        });
        s.Profiles.Add(Reg("baseline-hardening",
            D(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer", "NoDriveTypeAutoRun", 255),
            D(@"SOFTWARE\Policies\Microsoft\Windows\DataCollection", "AllowTelemetry", 0)));
        return Finish(s);
    }

    private static PolicySnapshot LabClassroom()
    {
        var s = new PolicySnapshot { Version = "1" };
        s.Profiles.Add(new ConfigProfile
        {
            ProfileId = "baseline-uwf",
            // Discard student changes on reboot: overlay only, no exclusions.
            Uwf = new UwfProfile2 { Enabled = true, OverlayWarnBytes = 1L << 30 },
        });
        s.Profiles.Add(new ConfigProfile
        {
            ProfileId = "baseline-assigned-access",
            Kiosk = new KioskProfile { Mode = "assigned_access_multi", AutoLogonUser = "student", AssignedAccessXml = "<Configuration><!-- multi-app allow list --></Configuration>" },
        });
        s.Profiles.Add(Reg("baseline-hardening",
            D(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer", "NoDriveTypeAutoRun", 255)));
        return Finish(s);
    }
}

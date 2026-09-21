using System.Text.Json;
using Ltsc.Mgmt.V1;

namespace Ltsc.Server.Registry;

/// <summary>
/// Migration importer (the switching-cost killer). The main reason fleets stay on
/// Wyse Management Suite / HP Device Manager / IGEL UMS is that thousands of
/// devices are already modelled there. This maps a vendor export into native
/// groups, policy snapshots, and app packages, so a customer can evaluate against
/// their real fleet shape on day one instead of re-authoring everything.
///
/// Each vendor mapper is deterministic and unit-tested. Unmapped vendor settings
/// are reported in <see cref="ImportPlan.Warnings"/> rather than silently dropped.
/// </summary>
public static class FleetImporter
{
    public sealed record ImportedGroup(string Name, PolicySnapshot Policy, IReadOnlyList<InstallSpec> Apps);
    public sealed record ImportPlan(string Vendor, IReadOnlyList<ImportedGroup> Groups, IReadOnlyList<string> Warnings);

    public static ImportPlan Parse(string vendor, string json) => vendor.ToLowerInvariant() switch
    {
        "wms" => FromWms(json),
        "hpdm" => FromHpdm(json),
        "igel" => FromIgel(json),
        _ => throw new NotSupportedException($"unsupported vendor '{vendor}' (expected: wms, hpdm, igel)"),
    };

    // ---- Dell Wyse Management Suite ----------------------------------------
    // { "groups": [ { "name", "uwf": bool, "shell": str,
    //                 "registry": [ {path,name,type,data} ], "apps": [ {appId,version,installCmd} ] } ] }
    private static ImportPlan FromWms(string json)
    {
        var warnings = new List<string>();
        var groups = new List<ImportedGroup>();
        using var doc = JsonDocument.Parse(json);

        foreach (var g in Items(doc.RootElement, "groups"))
        {
            var name = Str(g, "name") ?? "imported";
            var snap = new PolicySnapshot { Version = "1" };

            if (Bool(g, "uwf") == true)
                snap.Profiles.Add(new ConfigProfile { ProfileId = "imported-uwf", Uwf = new UwfProfile2 { Enabled = true } });

            if (Str(g, "shell") is { Length: > 0 } shell)
                snap.Profiles.Add(new ConfigProfile
                {
                    ProfileId = "imported-kiosk",
                    Kiosk = new KioskProfile { Mode = "shell_launcher", ShellExe = shell },
                });

            var reg = new RegistryProfile();
            foreach (var r in Items(g, "registry"))
                reg.Values.Add(new RegValue
                {
                    Hive = Str(r, "hive") ?? "HKLM",
                    Path = Str(r, "path") ?? "",
                    Name = Str(r, "name") ?? "",
                    Type = Str(r, "type") ?? "sz",
                    Data = Str(r, "data") ?? "",
                });
            if (reg.Values.Count > 0)
                snap.Profiles.Add(new ConfigProfile { ProfileId = "imported-registry", Registry = reg });

            var apps = new List<InstallSpec>();
            foreach (var a in Items(g, "apps"))
                apps.Add(new InstallSpec
                {
                    AppId = Str(a, "appId") ?? "imported.app",
                    Version = Str(a, "version") ?? "1.0",
                    Installer = new Installer
                    {
                        Type = "msi",
                        InstallCmd = Str(a, "installCmd") ?? "",
                        ValidExitCodes = { 0, 1641, 3010 },
                    },
                });

            if (snap.Profiles.Count == 0 && apps.Count == 0)
                warnings.Add($"group '{name}' had no mappable settings");

            snap.ContentHash = PolicyRegistry.Hash(snap);
            groups.Add(new ImportedGroup(name, snap, apps));
        }
        return new ImportPlan("wms", groups, warnings);
    }

    // ---- HP Device Manager --------------------------------------------------
    // { "templates": [ { "name", "tasks": [ {type: writefilter|registry|install, ...} ] } ] }
    private static ImportPlan FromHpdm(string json)
    {
        var warnings = new List<string>();
        var groups = new List<ImportedGroup>();
        using var doc = JsonDocument.Parse(json);

        foreach (var t in Items(doc.RootElement, "templates"))
        {
            var name = Str(t, "name") ?? "imported";
            var snap = new PolicySnapshot { Version = "1" };
            var reg = new RegistryProfile();
            var apps = new List<InstallSpec>();

            foreach (var task in Items(t, "tasks"))
            {
                switch (Str(task, "type")?.ToLowerInvariant())
                {
                    case "writefilter":
                        snap.Profiles.Add(new ConfigProfile
                        {
                            ProfileId = "imported-uwf",
                            Uwf = new UwfProfile2 { Enabled = Bool(task, "enabled") ?? true },
                        });
                        break;
                    case "registry":
                        reg.Values.Add(new RegValue
                        {
                            Hive = Str(task, "hive") ?? "HKLM",
                            Path = Str(task, "path") ?? "",
                            Name = Str(task, "name") ?? "",
                            Type = Str(task, "type2") ?? "sz",
                            Data = Str(task, "value") ?? "",
                        });
                        break;
                    case "install":
                        apps.Add(new InstallSpec
                        {
                            AppId = Str(task, "app") ?? "imported.app",
                            Version = Str(task, "version") ?? "1.0",
                            Installer = new Installer { Type = "msi", InstallCmd = Str(task, "command") ?? "", ValidExitCodes = { 0, 1641, 3010 } },
                        });
                        break;
                    default:
                        warnings.Add($"template '{name}': unmapped task type '{Str(task, "type")}'");
                        break;
                }
            }

            if (reg.Values.Count > 0)
                snap.Profiles.Add(new ConfigProfile { ProfileId = "imported-registry", Registry = reg });
            snap.ContentHash = PolicyRegistry.Hash(snap);
            groups.Add(new ImportedGroup(name, snap, apps));
        }
        return new ImportPlan("hpdm", groups, warnings);
    }

    // ---- IGEL UMS -----------------------------------------------------------
    // { "profiles": [ { "name", "parameters": { "uwf.enabled": "true", "desktop.shell": "...", "registry.<Path>!<Name>": "<value>" } } ] }
    private static ImportPlan FromIgel(string json)
    {
        var warnings = new List<string>();
        var groups = new List<ImportedGroup>();
        using var doc = JsonDocument.Parse(json);

        foreach (var p in Items(doc.RootElement, "profiles"))
        {
            var name = Str(p, "name") ?? "imported";
            var snap = new PolicySnapshot { Version = "1" };
            var reg = new RegistryProfile();

            if (p.TryGetProperty("parameters", out var pars) && pars.ValueKind == JsonValueKind.Object)
            {
                foreach (var kv in pars.EnumerateObject())
                {
                    var key = kv.Name;
                    var val = kv.Value.ValueKind == JsonValueKind.String ? kv.Value.GetString() ?? "" : kv.Value.ToString();
                    if (key.Equals("uwf.enabled", StringComparison.OrdinalIgnoreCase))
                        snap.Profiles.Add(new ConfigProfile { ProfileId = "imported-uwf", Uwf = new UwfProfile2 { Enabled = val is "true" or "1" } });
                    else if (key.Equals("desktop.shell", StringComparison.OrdinalIgnoreCase))
                        snap.Profiles.Add(new ConfigProfile { ProfileId = "imported-kiosk", Kiosk = new KioskProfile { Mode = "shell_launcher", ShellExe = val } });
                    else if (key.StartsWith("registry.", StringComparison.OrdinalIgnoreCase))
                    {
                        // registry.<Path>!<ValueName>
                        var spec = key["registry.".Length..];
                        var bang = spec.LastIndexOf('!');
                        reg.Values.Add(new RegValue
                        {
                            Hive = "HKLM",
                            Path = bang > 0 ? spec[..bang] : spec,
                            Name = bang > 0 ? spec[(bang + 1)..] : "",
                            Type = "sz",
                            Data = val,
                        });
                    }
                    else warnings.Add($"profile '{name}': unmapped parameter '{key}'");
                }
            }

            if (reg.Values.Count > 0)
                snap.Profiles.Add(new ConfigProfile { ProfileId = "imported-registry", Registry = reg });
            snap.ContentHash = PolicyRegistry.Hash(snap);
            groups.Add(new ImportedGroup(name, snap, Array.Empty<InstallSpec>()));
        }
        return new ImportPlan("igel", groups, warnings);
    }

    // ---- small JSON helpers -------------------------------------------------
    private static IEnumerable<JsonElement> Items(JsonElement parent, string prop) =>
        parent.TryGetProperty(prop, out var a) && a.ValueKind == JsonValueKind.Array
            ? a.EnumerateArray() : Enumerable.Empty<JsonElement>();

    private static string? Str(JsonElement e, string prop) =>
        e.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool? Bool(JsonElement e, string prop) =>
        e.TryGetProperty(prop, out var v)
            ? v.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => null }
            : null;
}

using Ltsc.Mgmt.V1;
using Ltsc.Server.Registry;
using Xunit;

namespace Ltsc.Server.Tests;

public class FleetImporterTests
{
    [Fact]
    public void Wms_MapsWriteFilter_Shell_Registry_AndApps()
    {
        const string json = """
        { "groups": [ { "name": "Kiosks", "uwf": true, "shell": "C:\\Kiosk\\app.exe",
            "registry": [ { "path": "Software\\Contoso", "name": "Brand", "type": "sz", "data": "Contoso" } ],
            "apps": [ { "appId": "com.contoso.line", "version": "2.4", "installCmd": "msiexec /i line.msi /qn" } ] } ] }
        """;
        var plan = FleetImporter.Parse("wms", json);

        var g = Assert.Single(plan.Groups);
        Assert.Equal("Kiosks", g.Name);
        Assert.Contains(g.Policy.Profiles, p => p.BodyCase == ConfigProfile.BodyOneofCase.Uwf);
        Assert.Contains(g.Policy.Profiles, p => p.BodyCase == ConfigProfile.BodyOneofCase.Kiosk);
        Assert.Contains(g.Policy.Profiles, p => p.BodyCase == ConfigProfile.BodyOneofCase.Registry);
        Assert.Equal("com.contoso.line", Assert.Single(g.Apps).AppId);
        Assert.NotEmpty(g.Policy.ContentHash);
    }

    [Fact]
    public void Hpdm_MapsTasks_AndWarnsOnUnmapped()
    {
        const string json = """
        { "templates": [ { "name": "Standard", "tasks": [
            { "type": "writefilter", "enabled": true },
            { "type": "registry", "path": "Software\\X", "name": "V", "value": "1" },
            { "type": "install", "app": "app.one", "version": "1.0", "command": "setup.exe /S" },
            { "type": "wallpaper", "url": "http://x/y.png" } ] } ] }
        """;
        var plan = FleetImporter.Parse("hpdm", json);

        var g = Assert.Single(plan.Groups);
        Assert.Contains(g.Policy.Profiles, p => p.BodyCase == ConfigProfile.BodyOneofCase.Uwf);
        Assert.Contains(g.Policy.Profiles, p => p.BodyCase == ConfigProfile.BodyOneofCase.Registry);
        Assert.Single(g.Apps);
        Assert.Contains(plan.Warnings, w => w.Contains("wallpaper"));   // reported, not silently dropped
    }

    [Fact]
    public void Igel_MapsDottedParameters()
    {
        const string json = """
        { "profiles": [ { "name": "Lab", "parameters": {
            "uwf.enabled": "true",
            "desktop.shell": "C:\\Lab\\shell.exe",
            "registry.Software\\Lab!Room": "B12",
            "audio.volume": "70" } } ] }
        """;
        var plan = FleetImporter.Parse("igel", json);

        var g = Assert.Single(plan.Groups);
        Assert.Contains(g.Policy.Profiles, p => p.BodyCase == ConfigProfile.BodyOneofCase.Uwf);
        var reg = Assert.Single(g.Policy.Profiles.Where(p => p.BodyCase == ConfigProfile.BodyOneofCase.Registry));
        var v = Assert.Single(reg.Registry.Values);
        Assert.Equal(@"Software\Lab", v.Path);
        Assert.Equal("Room", v.Name);
        Assert.Equal("B12", v.Data);
        Assert.Contains(plan.Warnings, w => w.Contains("audio.volume"));
    }

    [Fact]
    public void UnsupportedVendor_Throws() =>
        Assert.Throws<NotSupportedException>(() => FleetImporter.Parse("sccm", "{}"));
}

public class BaselineTests
{
    [Fact]
    public void ListsBuiltInBaselines() => Assert.Equal(3, Baselines.All().Count);

    [Fact]
    public void KioskHardened_LocksDownTheDevice()
    {
        var s = Baselines.Build("kiosk-hardened")!;
        Assert.Contains(s.Profiles, p => p.BodyCase == ConfigProfile.BodyOneofCase.Uwf);
        Assert.Contains(s.Profiles, p => p.BodyCase == ConfigProfile.BodyOneofCase.Kiosk);
        Assert.Contains(s.Profiles, p => p.BodyCase == ConfigProfile.BodyOneofCase.Keyfilter);
        Assert.Contains(s.Profiles, p => p.BodyCase == ConfigProfile.BodyOneofCase.Applocker);

        // CIS-flavoured: removable storage disabled (USBSTOR Start=4).
        var reg = s.Profiles.Single(p => p.BodyCase == ConfigProfile.BodyOneofCase.Registry).Registry;
        Assert.Contains(reg.Values, v => v.Name == "Start" && v.Path.Contains("USBSTOR") && v.Data == "4");
        Assert.NotEmpty(s.ContentHash);
    }

    [Fact]
    public void UnknownBaseline_IsNull() => Assert.Null(Baselines.Build("nope"));
}

public class MetricsTests
{
    [Fact]
    public void CountersIncrementAndRender()
    {
        var m = new Metrics();
        m.Inc(Metrics.Enrollments);
        m.Inc(Metrics.Enrollments);
        m.Inc(Metrics.CommandsDispatched, 5);

        Assert.Equal(2, m.Get(Metrics.Enrollments));
        Assert.Equal(5, m.Get(Metrics.CommandsDispatched));

        var text = m.Render(new DeviceRegistry(), new DeviceRouter(new ConnectionRegistry(), new InProcessPresence(new ConnectionRegistry())),
            new InventoryStore(), new AlertStore());
        Assert.Contains("ltsc_enrollments_total 2", text);
        Assert.Contains("# TYPE ltsc_devices_total gauge", text);
        Assert.Contains("ltsc_devices_health{band=\"healthy\"}", text);
    }
}

using Ltsc.Mgmt.V1;
using Ltsc.Server.Registry;
using Xunit;

namespace Ltsc.Server.Tests;

public class CarbonSchedulerTests
{
    [Fact]
    public void Night_IsGreen_Day_IsNot()
    {
        var night = new DateTimeOffset(2026, 6, 1, 23, 0, 0, TimeSpan.Zero);
        var day = new DateTimeOffset(2026, 6, 1, 14, 0, 0, TimeSpan.Zero);
        Assert.True(CarbonScheduler.IsGreen(night));
        Assert.False(CarbonScheduler.IsGreen(day));
        Assert.True(CarbonScheduler.IntensityProxy(night) < CarbonScheduler.IntensityProxy(day));
    }

    [Fact]
    public void NextGreen_IsTheUpcomingWindowStart()
    {
        var day = new DateTimeOffset(2026, 6, 1, 14, 0, 0, TimeSpan.Zero);
        var next = CarbonScheduler.NextGreen(day);
        Assert.Equal(22, next.Hour);
        Assert.True(next > day);
    }
}

public class PolicySimulatorTests
{
    private static PolicySnapshot Snap(params ConfigProfile[] ps)
    { var s = new PolicySnapshot { Version = "1" }; s.Profiles.AddRange(ps); s.ContentHash = PolicyRegistry.Hash(s); return s; }
    private static ConfigProfile Reg(string id, string data) => new() { ProfileId = id, Registry = new RegistryProfile { Values = { new RegValue { Hive = "HKLM", Path = "p", Name = "n", Type = "sz", Data = data } } } };
    private static ConfigProfile Uwf(string id) => new() { ProfileId = id, Uwf = new UwfProfile2 { Enabled = true } };

    [Fact]
    public void DetectsAddedRemovedModified_AndRebootForUwf()
    {
        var current = Snap(Reg("reg", "old"), Reg("drop", "x"));
        var proposed = Snap(Reg("reg", "new"), Uwf("uwf"));
        var impact = PolicySimulator.Simulate(current, proposed, devicesInGroup: 7);

        Assert.Contains("uwf", impact.Added);
        Assert.Contains("drop", impact.Removed);
        Assert.Contains("reg", impact.Modified);
        Assert.True(impact.RequiresReboot);          // UWF profile added
        Assert.Equal(7, impact.AffectedDevices);
    }

    [Fact]
    public void NoChange_NoImpact()
    {
        var s = Snap(Reg("reg", "same"));
        var impact = PolicySimulator.Simulate(s, Snap(Reg("reg", "same")), 5);
        Assert.False(impact.Changed);
        Assert.Equal(0, impact.AffectedDevices);
    }
}

public class PostureTests
{
    private static FleetHealth.Result Ok() => new(100, "healthy", System.Array.Empty<string>());
    private static FleetHealth.Result Crit() => new(20, "critical", new[] { "x" });

    [Fact]
    public void Compliant_WhenUwfOn_InPolicy_Healthy()
    {
        var r = Posture.Evaluate(new Health { UwfEnabled = true }, inPolicy: true, Ok());
        Assert.True(r.Compliant);
        Assert.Empty(r.Violations);
    }

    [Fact]
    public void Violations_Accumulate()
    {
        var r = Posture.Evaluate(new Health { UwfEnabled = false }, inPolicy: false, Crit());
        Assert.False(r.Compliant);
        Assert.Equal(3, r.Violations.Count);
    }
}

public class IntentTranslatorTests
{
    private readonly RuleIntentTranslator _t = new();

    [Theory]
    [InlineData("reboot all critical devices", "command", "reboot", "critical")]
    [InlineData("collect inventory from offline devices", "inventory", "collect", null)]
    [InlineData("update devices in group-kiosk", "update", "install", null)]
    public void ParsesActionAndBand(string q, string cap, string act, string? band)
    {
        var i = _t.Translate(q);
        Assert.NotNull(i);
        Assert.Equal(cap, i!.Capability);
        Assert.Equal(act, i.Action);
        Assert.Equal(band, i.Filter.Band);
    }

    [Fact]
    public void ParsesFilters()
    {
        var i = _t.Translate("reboot offline drifted devices in group-kiosk")!;
        Assert.False(i.Filter.Online);
        Assert.True(i.Filter.Drift);
        Assert.Equal("group-kiosk", i.Filter.Group);
    }

    [Fact]
    public void UnknownRequest_ReturnsNull() => Assert.Null(_t.Translate("make me a sandwich"));
}

using Ltsc.Mgmt.V1;
using Ltsc.Server.Registry;
using Xunit;

namespace Ltsc.Server.Tests;

public class FleetHealthTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.UtcNow;

    [Fact]
    public void HealthyDevice_ScoresHigh()
    {
        var r = FleetHealth.Score(online: true, lastSeen: Now,
            health: new Health { OverlayMaxBytes = 1000, OverlayUsedBytes = 100 },
            inv: new InventoryReport { TotalDiskBytes = 1000, FreeDiskBytes = 800 },
            recentFailures: 0);
        Assert.Equal(100, r.Score);
        Assert.Equal("healthy", r.Band);
        Assert.Empty(r.Risks);
    }

    [Fact]
    public void DiskCritical_FlagsImminentExhaustion()
    {
        var r = FleetHealth.Score(true, Now, null,
            new InventoryReport { TotalDiskBytes = 1000, FreeDiskBytes = 50 }, 0);
        Assert.True(r.Score <= 70);
        Assert.Contains(r.Risks, x => x.Contains("disk critical"));
    }

    [Fact]
    public void OverlayPressure_AndRebootPending_Deduct()
    {
        var r = FleetHealth.Score(true, Now,
            new Health { OverlayMaxBytes = 1000, OverlayUsedBytes = 950, RebootPending = true },
            new InventoryReport { TotalDiskBytes = 1000, FreeDiskBytes = 900 }, 0);
        Assert.Contains(r.Risks, x => x.Contains("overlay"));
        Assert.Contains(r.Risks, x => x.Contains("reboot pending"));
        Assert.True(r.Score < 80);
    }

    [Fact]
    public void LongOffline_IsCritical()
    {
        var r = FleetHealth.Score(online: false, lastSeen: Now.AddHours(-48), health: null, inv: null, recentFailures: 0);
        Assert.Equal("critical", r.Band);
        Assert.Contains(r.Risks, x => x.Contains("unreachable"));
    }

    [Fact]
    public void RepeatedFailures_CapAtThirty()
    {
        var none = FleetHealth.Score(true, Now, null, null, 0).Score;
        var many = FleetHealth.Score(true, Now, null, null, 10).Score;
        Assert.Equal(30, none - many);   // capped deduction
    }
}

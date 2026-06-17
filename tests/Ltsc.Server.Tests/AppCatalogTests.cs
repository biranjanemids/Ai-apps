using Ltsc.Mgmt.V1;
using Ltsc.Server.Registry;
using Xunit;

namespace Ltsc.Server.Tests;

public class AppCatalogTests
{
    private static InstallSpec Spec(string appId, string ver) => new()
    {
        AppId = appId,
        Version = ver,
        Installer = new Installer { Type = "msi", ArtifactId = "a1", InstallCmd = "msiexec /i x.msi /qn" },
    };

    [Fact]
    public void Register_And_ListByTenant()
    {
        var c = new AppCatalog();
        c.Register("tenant-a", "app.one", "1.0", Spec("app.one", "1.0"));
        c.Register("tenant-b", "app.two", "2.0", Spec("app.two", "2.0"));

        Assert.Single(c.ForTenant("tenant-a"));
        Assert.Equal("app.one", c.ForTenant("tenant-a")[0].AppId);
        Assert.Single(c.ForTenant("tenant-b"));               // tenant isolation
    }

    [Fact]
    public void Assign_TracksPerGroup()
    {
        var c = new AppCatalog();
        c.Register("tenant-a", "app.one", "1.0", Spec("app.one", "1.0"));
        c.Assign("tenant-a", "group-kiosk", "app.one");

        Assert.Contains("app.one", c.AssignedApps("tenant-a", "group-kiosk"));
        Assert.Empty(c.AssignedApps("tenant-a", "group-default"));   // only the assigned group
        Assert.Empty(c.AssignedApps("tenant-b", "group-kiosk"));     // not cross-tenant
    }

    [Fact]
    public void TryGet_ReturnsRegisteredSpec()
    {
        var c = new AppCatalog();
        c.Register("tenant-a", "app.one", "1.0", Spec("app.one", "1.0"));
        Assert.True(c.TryGet("tenant-a", "app.one", out var pkg));
        Assert.Equal("msi", pkg.Spec.Installer.Type);
        Assert.False(c.TryGet("tenant-a", "missing", out _));
    }
}

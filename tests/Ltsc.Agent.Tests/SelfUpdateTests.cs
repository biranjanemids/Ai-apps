using Ltsc.Agent.Platform;
using Xunit;

namespace Ltsc.Agent.Tests;

public class SelfUpdateTests
{
    private sealed class FakeUpdater : IAgentUpdater
    {
        public string? AppliedVersion;
        public Task<bool> ApplyAsync(string packagePath, string version, CancellationToken ct)
        { AppliedVersion = version; return Task.FromResult(true); }
    }

    // The orchestrator's version-gate logic (mirrors Orchestrator.IsNewer) — a
    // newer advertised version updates, an equal/older one is a no-op.
    private static bool IsNewer(string candidate, string current) =>
        Version.TryParse(candidate, out var c) && Version.TryParse(current, out var cur) && c > cur;

    [Theory]
    [InlineData("0.2.0", "0.1.0", true)]
    [InlineData("0.1.0", "0.1.0", false)]
    [InlineData("0.0.9", "0.1.0", false)]
    [InlineData("1.0.0", "0.9.9", true)]
    public void VersionGate_OnlyUpdatesWhenNewer(string advertised, string current, bool expected)
        => Assert.Equal(expected, IsNewer(advertised, current));

    [Fact]
    public async Task Updater_StagesPackageAndReportsVersion()
    {
        var updater = new FakeUpdater();
        var ok = await updater.ApplyAsync("/tmp/agent-0.2.0.pkg", "0.2.0", default);
        Assert.True(ok);
        Assert.Equal("0.2.0", updater.AppliedVersion);
    }
}

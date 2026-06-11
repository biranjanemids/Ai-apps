using Google.Protobuf;
using Ltsc.Agent.Modules;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Ltsc.Agent.Tests;

public class ConfigModuleTests
{
    private static ConfigModule Module(params FakeApplier[] appliers) =>
        new(appliers, NullLogger<ConfigModule>.Instance);

    private static RecordingContext Ctx(FakeUwf uwf) =>
        new(uwf, new FakeInstaller(), new FakeDetection(), new FakeSession());

    private static PolicySnapshot Snap(string version, string hash, params ConfigProfile[] profiles)
    {
        var s = new PolicySnapshot { Version = version, ContentHash = hash };
        s.Profiles.AddRange(profiles);
        return s;
    }

    private static ConfigProfile Reg(string id = "reg") => new()
    {
        ProfileId = id,
        Registry = new RegistryProfile { Values = { new RegValue { Hive = "HKLM", Path = "p", Name = "n", Type = "sz", Data = "d" } } },
    };

    private static ConfigProfile Pwr(string id = "pwr") => new()
    {
        ProfileId = id,
        Power = new PowerProfile { SleepMinutes = 10 },
    };

    [Fact]
    public async Task Reconcile_AppliesDriftedProfile_BracketsUwf_AndPersistsVersion()
    {
        var uwf = new FakeUwf();
        var reg = new FakeApplier(ConfigProfile.BodyOneofCase.Registry, persist: true) { InDesiredState = false };
        using var ctx = Ctx(uwf);

        await Module(reg).ReconcileAsync(Snap("1", "hash-1", Reg()), ctx, default);

        Assert.Equal(1, reg.ApplyCount);
        Assert.Equal(1, uwf.EnterCount);                       // persistent change => UWF bracket
        Assert.Equal("Succeeded", ctx.Results.Single().Status);
        Assert.Equal("hash-1", ctx.Store.GetIdentity("policy_version"));
    }

    [Fact]
    public async Task Reconcile_IsIdempotent_SecondPassIsNoOp()
    {
        var uwf = new FakeUwf();
        var reg = new FakeApplier(ConfigProfile.BodyOneofCase.Registry, persist: true) { InDesiredState = false };
        using var ctx = Ctx(uwf);
        var snap = Snap("1", "hash-1", Reg());

        await Module(reg).ReconcileAsync(snap, ctx, default);   // applies
        await Module(reg).ReconcileAsync(snap, ctx, default);   // converged => no drift

        Assert.Equal(1, reg.ApplyCount);                        // not applied twice
        Assert.Equal(1, uwf.EnterCount);                        // no second servicing bracket
        Assert.Contains(ctx.Progress, p => p.State == "Reconciled" && p.Detail == "no drift");
    }

    [Fact]
    public async Task Reconcile_NonPersistentProfile_DoesNotBracketUwf()
    {
        var uwf = new FakeUwf();
        var pwr = new FakeApplier(ConfigProfile.BodyOneofCase.Power, persist: false) { InDesiredState = false };
        using var ctx = Ctx(uwf);

        await Module(pwr).ReconcileAsync(Snap("1", "h", Pwr()), ctx, default);

        Assert.Equal(1, pwr.ApplyCount);
        Assert.Equal(0, uwf.EnterCount);                        // no persistent change => no bracket
        Assert.Equal("Succeeded", ctx.Results.Single().Status);
    }

    [Fact]
    public async Task Reconcile_ProfileFails_RollsBackUwf_AndNeverReportsGreen()
    {
        var uwf = new FakeUwf();
        var reg = new FakeApplier(ConfigProfile.BodyOneofCase.Registry, persist: true) { InDesiredState = false, FailOnApply = true };
        using var ctx = Ctx(uwf);

        await Module(reg).ReconcileAsync(Snap("1", "hash-1", Reg()), ctx, default);

        Assert.True(uwf.RollbackCalled);
        Assert.Equal("Failed", ctx.Results.Single().Status);
        Assert.Null(ctx.Store.GetIdentity("policy_version"));   // version NOT advanced on failure
    }

    [Fact]
    public async Task ApplyConfigCommand_ReconcilesSnapshotFromSpec()
    {
        var uwf = new FakeUwf();
        var reg = new FakeApplier(ConfigProfile.BodyOneofCase.Registry, persist: true) { InDesiredState = false };
        using var ctx = Ctx(uwf);

        var cmd = new CommandEnvelope
        {
            CommandId = "c1",
            Capability = "config",
            Action = "apply_config",
            Spec = Snap("7", "hash-7", Reg()).ToByteString(),
        };

        await Module(reg).ApplyAsync(cmd, ctx, default);

        Assert.Equal(1, reg.ApplyCount);
        Assert.Equal("Succeeded", ctx.Results.Single().Status);
        Assert.Equal("hash-7", ctx.Store.GetIdentity("policy_version"));
    }
}

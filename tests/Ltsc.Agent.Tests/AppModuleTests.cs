using Google.Protobuf;
using Ltsc.Agent.Models;
using Ltsc.Agent.Modules;
using Ltsc.Agent.Platform;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Ltsc.Agent.Tests;

public class AppModuleTests
{
    private static AppModule NewModule() => new(NullLogger<AppModule>.Instance);

    private static InstallSpec MakeSpec(bool withConfig = true, params int[] validExit)
    {
        var spec = new InstallSpec
        {
            AppId = "app",
            Version = "1.0",
            Installer = new Installer { Type = "msi", ArtifactId = "a1", InstallCmd = "install" },
            Delivery = new Delivery { Mode = "immediate" },
            Defer = new DeferPolicy { AllowDefer = false },
            Reboot = new RebootPolicy { Required = false, AllowDefer = true, MaxTotalSeconds = 3600 },
            Uwf = new UwfPolicy { Strategy = "hybrid" },
        };
        spec.Installer.ValidExitCodes.AddRange(validExit.Length == 0 ? new[] { 0, 1641, 3010 } : validExit);
        spec.Detect.Add(new DetectionRule { Kind = "registry", Key = "k", Op = "exists" });
        if (withConfig)
            spec.Config.Add(new ConfigTask
            {
                TaskId = "t1",
                Kind = "registry",
                Verify = new DetectionRule { Kind = "registry", Key = "k", Op = "exists" },
            });
        return spec;
    }

    private static CommandEnvelope Cmd(InstallSpec spec) => new()
    {
        CommandId = Guid.NewGuid().ToString("n"),
        Capability = "app",
        Action = "install",
        Spec = spec.ToByteString(),
    };

    private static RecordingContext Ctx(FakeUwf uwf, FakeInstaller inst, FakeDetection det, FakeSession? session = null)
        => new(uwf, inst, det, session ?? new FakeSession());

    [Fact]
    public async Task Idempotent_WhenAlreadyInstalled_SkipsInstallerAndSucceeds()
    {
        var uwf = new FakeUwf();
        var inst = new FakeInstaller();
        var det = new FakeDetection { Installed = true };  // detection already passes
        using var ctx = Ctx(uwf, inst, det);

        await NewModule().ApplyAsync(Cmd(MakeSpec()), ctx, default);

        Assert.Equal(0, inst.CallCount);                                   // never ran the installer
        Assert.Equal(0, uwf.EnterCount);                                   // never entered servicing
        Assert.Contains(ctx.Progress, p => p.State == nameof(InstallState.AlreadyInstalled));
        Assert.Equal("Succeeded", ctx.Results.Single().Status);
    }

    [Fact]
    public async Task Install_With3010_ReportsPendingRebootThenSucceeded()
    {
        var uwf = new FakeUwf();
        var inst = new FakeInstaller { ExitCode = 3010, RebootRequired = true };
        var det = new FakeDetection { Installed = false };
        inst.OnRun = () => det.Installed = true;                           // installer satisfies detection
        using var ctx = Ctx(uwf, inst, det);                              // non-interactive => reboot proceeds

        await NewModule().ApplyAsync(Cmd(MakeSpec()), ctx, default);

        Assert.Equal(1, inst.CallCount);
        Assert.Collection(ctx.Results,
            r => Assert.Equal("InstalledPendingReboot", r.Status),         // interim status
            r =>
            {
                Assert.Equal("Succeeded", r.Status);
                Assert.Equal(3010, r.ExitCode);
                Assert.Equal("rebooted", r.RebootState);
                Assert.True(r.UwfReenabled);
            });
        Assert.Contains(ctx.Progress, p => p.State == nameof(InstallState.PendingReboot));
        Assert.Contains(ctx.Progress, p => p.State == nameof(InstallState.PostRebootVerify));
    }

    [Fact]
    public async Task ConfigVerifyFails_RollsBackAndNeverReportsGreen()
    {
        var uwf = new FakeUwf();
        var inst = new FakeInstaller { ExitCode = 0 };                     // installs, but...
        var det = new FakeDetection { Installed = false };                 // ...config verify never passes
        using var ctx = Ctx(uwf, inst, det);

        await NewModule().ApplyAsync(Cmd(MakeSpec(withConfig: true)), ctx, default);

        Assert.Equal(1, inst.CallCount);
        Assert.True(uwf.RollbackCalled);                                   // UWF state restored
        Assert.Equal("RolledBack", ctx.Results.Single().Status);
        Assert.DoesNotContain(ctx.Progress, p => p.State == nameof(InstallState.Succeeded));
        Assert.Contains(ctx.Results.Single().ConfigResults, c => c.TaskId == "t1" && !c.Verified);
    }

    [Fact]
    public async Task InstallerThrows_RollsBackUwf()
    {
        var uwf = new FakeUwf();
        var inst = new FakeInstaller { Throw = new InvalidOperationException("boom") };
        var det = new FakeDetection { Installed = false };
        using var ctx = Ctx(uwf, inst, det);

        await NewModule().ApplyAsync(Cmd(MakeSpec()), ctx, default);

        Assert.True(uwf.RollbackCalled);
        Assert.Equal("RolledBack", ctx.Results.Single().Status);
    }

    [Fact]
    public async Task Resume_AtPostRebootVerify_FinishesWithoutRerunningInstaller()
    {
        var uwf = new FakeUwf();
        var inst = new FakeInstaller();
        var det = new FakeDetection { Installed = true };                  // post-reboot detection passes
        using var ctx = Ctx(uwf, inst, det);

        // Simulate a job persisted just before the reboot.
        var job = new InstallJob
        {
            CommandId = "resume-1",
            Spec = MakeSpec().ToByteArray(),
            State = InstallState.PostRebootVerify,
        };

        await NewModule().ResumeAsync(job, ctx, default);

        Assert.Equal(0, inst.CallCount);                                   // did NOT reinstall
        Assert.Equal(0, uwf.EnterCount);                                   // did NOT re-enter servicing
        var result = ctx.Results.Single();
        Assert.Equal("Succeeded", result.Status);
        Assert.Equal("rebooted", result.RebootState);
    }

    [Fact]
    public async Task UserDefersInstall_StopsUnderBudgetAndPersistsJob()
    {
        var uwf = new FakeUwf();
        var inst = new FakeInstaller();
        var det = new FakeDetection { Installed = false };
        var session = new FakeSession { Interactive = true, InstallProceed = false }; // user snoozes
        using var ctx = Ctx(uwf, inst, det, session);

        var spec = MakeSpec();
        spec.Defer = new DeferPolicy { AllowDefer = true, MaxCount = 3, MaxTotalSeconds = 72 * 3600, SnoozeStepSeconds = 3600 };

        await NewModule().ApplyAsync(Cmd(spec), ctx, default);

        Assert.Equal(0, inst.CallCount);                                   // nothing installed yet
        Assert.Equal(nameof(InstallState.AwaitingUserDefer), ctx.Progress[^1].State);
        Assert.Contains(ctx.Events, e => e.Type == "install.deferred");

        // Deferral budget persisted for the next eligibility tick.
        var persisted = ctx.Store.LoadResumableJobs().Single();
        Assert.Equal(1, persisted.DeferCount);
    }

    [Fact]
    public async Task ForcedInstall_WhenDeferCountExhausted_ProceedsToSucceeded()
    {
        var uwf = new FakeUwf();
        var inst = new FakeInstaller { ExitCode = 0 };
        var det = new FakeDetection { Installed = false };
        inst.OnRun = () => det.Installed = true;
        var session = new FakeSession { Interactive = true, InstallProceed = false }; // user would snooze
        using var ctx = Ctx(uwf, inst, det, session);

        var spec = MakeSpec();
        spec.Defer = new DeferPolicy { AllowDefer = true, MaxCount = 0, MaxTotalSeconds = 72 * 3600 }; // budget already exhausted

        await NewModule().ApplyAsync(Cmd(spec), ctx, default);

        Assert.Contains(ctx.Events, e => e.Type == "install.defer_exhausted");
        Assert.Equal(1, inst.CallCount);
        Assert.Equal("Succeeded", ctx.Results.Single().Status);
    }
}

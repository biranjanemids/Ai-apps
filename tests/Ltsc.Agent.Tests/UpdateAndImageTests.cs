using Google.Protobuf;
using Ltsc.Agent.Modules;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Ltsc.Agent.Tests;

public class UpdateAndImageTests
{
    private static CommandEnvelope Cmd(string cap, string action, ByteString? spec = null) =>
        new() { CommandId = "c1", Capability = cap, Action = action, Spec = spec ?? ByteString.Empty };

    // ---- OS update ----------------------------------------------------------

    [Fact]
    public async Task Update_Scan_ReportsAvailableUpdates()
    {
        var updates = new FakeOsUpdateManager();
        using var ctx = new RecordingContext(new FakeUwf(), new FakeInstaller(), new FakeDetection(), new FakeSession(), osUpdates: updates);

        await new UpdateModule(NullLogger<UpdateModule>.Instance).ApplyAsync(Cmd("update", "scan"), ctx, default);

        Assert.Contains(ctx.Events, e => e.Type == "update.scan");
        Assert.Equal("Succeeded", ctx.Results.Single().Status);
    }

    [Fact]
    public async Task Update_Install_BracketsUwf_InstallsAndHandlesReboot()
    {
        var uwf = new FakeUwf();
        var updates = new FakeOsUpdateManager();
        using var ctx = new RecordingContext(uwf, new FakeInstaller(), new FakeDetection(), new FakeSession(), osUpdates: updates);

        var spec = new UpdateSpec { Reboot = new RebootPolicy { Required = true } }.ToByteString();
        await new UpdateModule(NullLogger<UpdateModule>.Instance).ApplyAsync(Cmd("update", "install", spec), ctx, default);

        Assert.Equal(1, uwf.EnterCount);                       // persistent change bracketed
        Assert.Equal(2, updates.InstalledCount);
        // interim pending-reboot, then succeeded (non-interactive session => reboot proceeds)
        Assert.Contains(ctx.Results, r => r.Status == "InstalledPendingReboot");
        Assert.Contains(ctx.Results, r => r.Status == "Succeeded" && r.RebootState == "rebooted");
    }

    [Fact]
    public async Task Update_Install_RespectsKbBlock()
    {
        var updates = new FakeOsUpdateManager();
        using var ctx = new RecordingContext(new FakeUwf(), new FakeInstaller(), new FakeDetection(), new FakeSession(), osUpdates: updates);

        // Block both updates -> nothing to install.
        var spec = new UpdateSpec { KbBlock = { "KB1", "KB2" } }.ToByteString();
        await new UpdateModule(NullLogger<UpdateModule>.Instance).ApplyAsync(Cmd("update", "install", spec), ctx, default);

        Assert.Equal(0, updates.InstalledCount);
        Assert.Equal("Succeeded", ctx.Results.Single().Status);
    }

    // ---- imaging / BMR ------------------------------------------------------

    [Fact]
    public async Task Bmr_RunsStagesToDone_AndApplies()
    {
        var imaging = new FakeImagingEngine { Model = "GenericThinClient" };
        using var ctx = new RecordingContext(new FakeUwf(), new FakeInstaller(), new FakeDetection(), new FakeSession(), imaging: imaging);

        var spec = new ImageSpec { ImageId = "img1", Format = "ffu", WipePolicy = "full", Model = "GenericThinClient" }.ToByteString();
        await new ImageModule(NullLogger<ImageModule>.Instance).ApplyAsync(Cmd("image", "trigger_bmr", spec), ctx, default);

        Assert.True(imaging.ApplyCalled);
        foreach (var stage in new[] { "Pulling", "Applying", "Sealing", "Rejoining", "Done" })
            Assert.Contains(ctx.Progress, p => p.State == stage);
        Assert.Equal("Succeeded", ctx.Results.Single().Status);
    }

    [Fact]
    public async Task Bmr_ModelMismatch_BlocksWipe()
    {
        var imaging = new FakeImagingEngine { Model = "ThinClientB" };
        using var ctx = new RecordingContext(new FakeUwf(), new FakeInstaller(), new FakeDetection(), new FakeSession(), imaging: imaging);

        var spec = new ImageSpec { ImageId = "img1", Format = "ffu", Model = "ThinClientA" }.ToByteString();
        await new ImageModule(NullLogger<ImageModule>.Instance).ApplyAsync(Cmd("image", "trigger_bmr", spec), ctx, default);

        Assert.False(imaging.ApplyCalled);                     // never wiped
        Assert.Contains(ctx.Events, e => e.Type == "bmr.model_mismatch");
        Assert.Equal("Failed", ctx.Results.Single().Status);
    }

    [Fact]
    public async Task Capture_UploadsImage()
    {
        var imaging = new FakeImagingEngine();
        var uploader = new FakeArtifactUploader();
        using var ctx = new RecordingContext(new FakeUwf(), new FakeInstaller(), new FakeDetection(), new FakeSession(),
            imaging: imaging, uploads: uploader);

        var spec = new CaptureSpec { Format = "ffu", TargetDrive = "0" }.ToByteString();
        await new ImageModule(NullLogger<ImageModule>.Instance).ApplyAsync(Cmd("image", "capture", spec), ctx, default);

        Assert.True(imaging.CaptureCalled);
        Assert.Single(uploader.Uploaded);
        Assert.Equal("Succeeded", ctx.Results.Single().Status);
    }
}

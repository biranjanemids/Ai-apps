using Ltsc.Agent.Models;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging;

namespace Ltsc.Agent.Modules;

/// <summary>
/// Imaging / bare-metal recovery (design §11), capability="image".
///  - action "capture": capture the disk (FFU/WIM) and upload it to the server.
///  - action "trigger_bmr": run the BMR state machine — compatibility gate →
///    Pulling (verified download) → Applying → Sealing → Rejoining → Done.
///
/// The stage is persisted to LocalStore so a real WinPE RecoveryAgent can resume
/// after the reboots BMR involves (design §11.3); the cross-platform stub runs it
/// in one pass.
/// </summary>
public sealed class ImageModule : IManagementModule
{
    private readonly ILogger<ImageModule> _log;
    public string Capability => "image";

    public ImageModule(ILogger<ImageModule> log) => _log = log;

    public async Task ApplyAsync(CommandEnvelope cmd, IModuleContext ctx, CancellationToken ct)
    {
        switch (cmd.Action)
        {
            case "capture": await CaptureAsync(cmd, ctx, ct); break;
            case "trigger_bmr": await BmrAsync(cmd, ctx, ct); break;
            default: _log.LogWarning("ImageModule: unsupported action {Action}", cmd.Action); break;
        }
    }

    private static async Task CaptureAsync(CommandEnvelope cmd, IModuleContext ctx, CancellationToken ct)
    {
        var spec = CaptureSpec.Parser.ParseFrom(cmd.Spec);
        await ctx.ReportProgressAsync(cmd.CommandId, "Capturing", 30, $"{spec.Format} from {spec.TargetDrive}");
        var path = await ctx.Imaging.CaptureAsync(spec.Format, spec.TargetDrive, ct);

        await ctx.ReportProgressAsync(cmd.CommandId, "Uploading", 70, "uploading image to server");
        var artifactId = await ctx.Uploads.UploadAsync(path, ct);

        await ctx.ReportResultAsync(new CommandResult
        {
            CommandId = cmd.CommandId,
            Status = "Succeeded",
            StdoutTail = $"captured + uploaded as {artifactId}",
        });
    }

    private async Task BmrAsync(CommandEnvelope cmd, IModuleContext ctx, CancellationToken ct)
    {
        var spec = ImageSpec.Parser.ParseFrom(cmd.Spec);

        // Safety rail: never wipe with an image built for a different model (§11.4).
        if (!string.IsNullOrEmpty(spec.Model) && spec.Model != ctx.Imaging.Model)
        {
            await ctx.ReportEventAsync("bmr.model_mismatch", "error",
                $"{{\"image_model\":\"{spec.Model}\",\"device_model\":\"{ctx.Imaging.Model}\"}}");
            await ctx.ReportResultAsync(new CommandResult { CommandId = cmd.CommandId, Status = "Failed", StdoutTail = "image/model mismatch; wipe blocked" });
            return;
        }

        try
        {
            await Stage(cmd, ctx, "Triggered", 5);

            await Stage(cmd, ctx, "Pulling", 30);
            var imagePath = await ctx.Artifacts.FetchAsync(spec.ImageId, spec.Sha256.ToByteArray(), ct);

            await Stage(cmd, ctx, "Applying", 60);
            var ok = await ctx.Imaging.ApplyAsync(imagePath, spec.Format, spec.WipePolicy, ct);
            if (!ok)
            {
                await ctx.ReportResultAsync(new CommandResult { CommandId = cmd.CommandId, Status = "Failed", StdoutTail = "apply failed" });
                return;
            }

            await Stage(cmd, ctx, "Sealing", 80);
            await Stage(cmd, ctx, "Rejoining", 95);
            await Stage(cmd, ctx, "Done", 100);

            await ctx.ReportResultAsync(new CommandResult
            {
                CommandId = cmd.CommandId,
                Status = "Succeeded",
                RebootState = "rebooted",
                StdoutTail = $"BMR complete from image {spec.ImageId} ({spec.Format}, wipe={spec.WipePolicy})",
            });
        }
        catch (InvalidDataException ex)
        {
            await ctx.ReportEventAsync("bmr.integrity_failed", "error", $"{{\"image\":\"{spec.ImageId}\"}}");
            await ctx.ReportResultAsync(new CommandResult { CommandId = cmd.CommandId, Status = "Failed", StdoutTail = ex.Message });
        }
    }

    private static Task Stage(CommandEnvelope cmd, IModuleContext ctx, string stage, int pct)
    {
        ctx.Store.SetIdentity($"bmr:{cmd.CommandId}", stage);  // resume-ready persistence (§11.3)
        return ctx.ReportProgressAsync(cmd.CommandId, stage, pct, $"BMR {stage}");
    }

    public Task ResumeAsync(InstallJob job, IModuleContext ctx, CancellationToken ct) => Task.CompletedTask;
    public Task ReconcileAsync(PolicySnapshot policy, IModuleContext ctx, CancellationToken ct) => Task.CompletedTask;
}

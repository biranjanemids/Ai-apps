using Ltsc.Agent.Models;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging;

namespace Ltsc.Agent.Modules;

/// <summary>
/// Remote shadow / remote assist (design §10), capability="shadow", action="start".
/// Requires on-device consent before streaming any frames, then streams the
/// framebuffer to the server. Consent decisions and session outcome are reported
/// as events/results for audit.
/// </summary>
public sealed class ShadowModule : IManagementModule
{
    private readonly ILogger<ShadowModule> _log;
    public string Capability => "shadow";

    public ShadowModule(ILogger<ShadowModule> log) => _log = log;

    public async Task ApplyAsync(CommandEnvelope cmd, IModuleContext ctx, CancellationToken ct)
    {
        if (cmd.Action != "start")
        {
            _log.LogWarning("ShadowModule: unsupported action {Action}", cmd.Action);
            return;
        }

        var sessionId = cmd.CommandId;

        // Consent gate — no frame leaves the device without it (design §10).
        var consent = await ctx.Session.PromptShadowConsentAsync("administrator", ct);
        if (!consent)
        {
            await ctx.ReportEventAsync("shadow.consent_denied", "warn", $"{{\"session\":\"{sessionId}\"}}");
            await ctx.ReportResultAsync(new CommandResult { CommandId = cmd.CommandId, Status = "Failed", StdoutTail = "consent denied" });
            return;
        }

        await ctx.ReportEventAsync("shadow.consent_granted", "info", $"{{\"session\":\"{sessionId}\"}}");
        await ctx.ReportProgressAsync(cmd.CommandId, "Shadowing", 50, "streaming frames");

        var frames = await ctx.Shadow.RunAsync(ctx.Screen, sessionId, maxFrames: 10, fps: 5, ct);

        await ctx.ReportResultAsync(new CommandResult
        {
            CommandId = cmd.CommandId,
            Status = "Succeeded",
            StdoutTail = $"shadow session sent {frames} frame(s)",
        });
    }

    public Task ResumeAsync(InstallJob job, IModuleContext ctx, CancellationToken ct) => Task.CompletedTask;
    public Task ReconcileAsync(PolicySnapshot policy, IModuleContext ctx, CancellationToken ct) => Task.CompletedTask;
}

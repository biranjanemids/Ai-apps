using Ltsc.Agent.Models;
using Ltsc.Agent.Platform;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging;

namespace Ltsc.Agent.Modules;

/// <summary>
/// OS / feature update control (design §10), capability="update".
///  - action "scan": report available updates.
///  - action "install": scan, filter by ring/allow/block, UWF-bracket the
///    persistent install, install via the OS update manager, then handle the
///    required reboot with the same deferral semantics as app installs.
/// </summary>
public sealed class UpdateModule : IManagementModule
{
    private readonly ILogger<UpdateModule> _log;
    public string Capability => "update";

    public UpdateModule(ILogger<UpdateModule> log) => _log = log;

    public async Task ApplyAsync(CommandEnvelope cmd, IModuleContext ctx, CancellationToken ct)
    {
        var spec = cmd.Spec.IsEmpty ? new UpdateSpec() : UpdateSpec.Parser.ParseFrom(cmd.Spec);

        await ctx.ReportProgressAsync(cmd.CommandId, "Scanning", 10, "querying available updates");
        var available = await ctx.OsUpdates.ScanAsync(spec.IncludeFeatureUpdates, ct);

        // Apply allow/block KB filters.
        var selected = available.Where(u =>
            (spec.KbAllow.Count == 0 || spec.KbAllow.Contains(u.Kb)) &&
            !spec.KbBlock.Contains(u.Kb)).ToList();

        if (cmd.Action == "scan")
        {
            await ctx.ReportEventAsync("update.scan", "info",
                $"{{\"available\":{available.Count},\"selected\":{selected.Count}}}");
            await ctx.ReportResultAsync(new CommandResult
            {
                CommandId = cmd.CommandId,
                Status = "Succeeded",
                StdoutTail = $"{available.Count} update(s) available, {selected.Count} selected",
            });
            return;
        }

        if (cmd.Action != "install")
        {
            _log.LogWarning("UpdateModule: unsupported action {Action}", cmd.Action);
            return;
        }

        if (selected.Count == 0)
        {
            await ctx.ReportResultAsync(new CommandResult { CommandId = cmd.CommandId, Status = "Succeeded", StdoutTail = "no applicable updates" });
            return;
        }

        // Updates are persistent writes -> bracket with the write filter (§4.5/§8.6).
        var uwfWas = ctx.Uwf.IsEnabled();
        var plan = ctx.Uwf.EnterServicing(new UwfPolicy { Strategy = "always_disable" }, new[] { "C:\\Windows" });
        try
        {
            await ctx.ReportProgressAsync(cmd.CommandId, "Installing", 50, $"installing {selected.Count} update(s)");
            var result = await ctx.OsUpdates.InstallAsync(selected, ct);

            var uwfReenabled = ctx.Uwf.ExitServicing(plan);
            if (uwfWas && !uwfReenabled)
            {
                ctx.Uwf.Rollback(plan);
                await ctx.ReportResultAsync(new CommandResult { CommandId = cmd.CommandId, Status = "Failed", StdoutTail = "UWF failed to re-enable", UwfReenabled = false });
                return;
            }

            // Reboot handling: same deferral + deadline model as app installs (§8.4).
            var rebootState = "none";
            if (result.RebootRequired || (spec.Reboot?.Force ?? false))
            {
                await ctx.ReportProgressAsync(cmd.CommandId, "PendingReboot", 90, "reboot required");
                await ctx.ReportResultAsync(new CommandResult
                {
                    CommandId = cmd.CommandId,
                    Status = "InstalledPendingReboot",
                    RebootState = "pending",
                    UwfReenabled = uwfReenabled,
                    StdoutTail = result.Detail,
                });

                var allowDefer = spec.Reboot?.AllowDefer ?? false;
                var deadline = DateTimeOffset.UtcNow.AddSeconds(spec.Reboot?.MaxTotalSeconds ?? 0);
                var rebootNow = !allowDefer || !ctx.Session.HasInteractiveSession()
                    || await ctx.Session.PromptRebootAsync(deadline, ct);
                if (!rebootNow)
                {
                    await ctx.ReportEventAsync("reboot.deferred", "info", $"{{\"deadline\":\"{deadline:o}\"}}");
                    return;
                }
                rebootState = "rebooted";
            }

            await ctx.ReportProgressAsync(cmd.CommandId, "Succeeded", 100, result.Detail);
            await ctx.ReportResultAsync(new CommandResult
            {
                CommandId = cmd.CommandId,
                Status = "Succeeded",
                RebootState = rebootState,
                UwfReenabled = uwfReenabled,
                StdoutTail = result.Detail,
            });
        }
        catch (Exception ex)
        {
            ctx.Uwf.Rollback(plan);
            _log.LogError(ex, "Update install failed");
            await ctx.ReportResultAsync(new CommandResult { CommandId = cmd.CommandId, Status = "Failed", StdoutTail = ex.Message, UwfReenabled = ctx.Uwf.IsEnabled() });
        }
    }

    public Task ResumeAsync(InstallJob job, IModuleContext ctx, CancellationToken ct) => Task.CompletedTask;
    public Task ReconcileAsync(PolicySnapshot policy, IModuleContext ctx, CancellationToken ct) => Task.CompletedTask;
}

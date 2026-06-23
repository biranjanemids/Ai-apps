using Ltsc.Agent.Models;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging;

namespace Ltsc.Agent.Modules;

/// <summary>
/// Inventory / telemetry (design §10). Collects a hardware+software asset report
/// on demand (command capability="inventory", action="collect") and reports it
/// to the server. The agent also reports inventory at startup via the orchestrator.
/// </summary>
public sealed class InventoryModule : IManagementModule
{
    private readonly ILogger<InventoryModule> _log;
    public string Capability => "inventory";

    public InventoryModule(ILogger<InventoryModule> log) => _log = log;

    public async Task ApplyAsync(CommandEnvelope cmd, IModuleContext ctx, CancellationToken ct)
    {
        if (cmd.Action != "collect")
        {
            _log.LogWarning("InventoryModule: unsupported action {Action}", cmd.Action);
            return;
        }
        var report = ctx.Inventory.Collect(ctx.Uwf.IsEnabled());
        await ctx.ReportInventoryAsync(report);
        await ctx.ReportResultAsync(new CommandResult { CommandId = cmd.CommandId, Status = "Succeeded", StdoutTail = "inventory collected" });
    }

    public Task ResumeAsync(InstallJob job, IModuleContext ctx, CancellationToken ct) => Task.CompletedTask;
    public Task ReconcileAsync(PolicySnapshot policy, IModuleContext ctx, CancellationToken ct) => Task.CompletedTask;
}

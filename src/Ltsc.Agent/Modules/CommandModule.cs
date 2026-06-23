using Ltsc.Agent.Models;
using Ltsc.Agent.Platform;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging;

namespace Ltsc.Agent.Modules;

/// <summary>
/// Remote commands (design §10): reboot, shutdown, restart_services, run_script,
/// collect_logs, wake. Each reports a CommandResult with exit code and output
/// tail. Power actions are gated in the executor so demo/CI hosts are safe.
/// </summary>
public sealed class CommandModule : IManagementModule
{
    private readonly ILogger<CommandModule> _log;
    public string Capability => "command";

    public CommandModule(ILogger<CommandModule> log) => _log = log;

    public async Task ApplyAsync(CommandEnvelope cmd, IModuleContext ctx, CancellationToken ct)
    {
        await ctx.ReportProgressAsync(cmd.CommandId, cmd.Action, 10, "started");
        ExecResult r;
        try
        {
            r = cmd.Action switch
            {
                "reboot" => await ctx.Commands.RebootAsync(30, ct),
                "shutdown" => await ctx.Commands.ShutdownAsync(30, ct),
                "collect_logs" => await ctx.Commands.CollectLogsAsync(ct),
                "run_script" => await RunScript(cmd, ctx, ct),
                "restart_services" => await RestartServices(cmd, ctx, ct),
                "wake" => await ctx.Commands.WakeAsync(System.Text.Encoding.UTF8.GetString(cmd.Spec.ToByteArray()), ct),
                _ => new ExecResult(-1, $"unsupported action {cmd.Action}"),
            };
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Command {Action} failed", cmd.Action);
            r = new ExecResult(-1, ex.Message);
        }

        await ctx.ReportResultAsync(new CommandResult
        {
            CommandId = cmd.CommandId,
            Status = r.ExitCode == 0 ? "Succeeded" : "Failed",
            ExitCode = r.ExitCode,
            StdoutTail = r.Output,
        });
    }

    private static async Task<ExecResult> RunScript(CommandEnvelope cmd, IModuleContext ctx, CancellationToken ct)
    {
        var spec = ScriptSpec.Parser.ParseFrom(cmd.Spec);
        return await ctx.Commands.RunScriptAsync(spec.Interpreter, spec.Script, spec.TimeoutSeconds, ct);
    }

    private static async Task<ExecResult> RestartServices(CommandEnvelope cmd, IModuleContext ctx, CancellationToken ct)
    {
        var spec = RestartServicesSpec.Parser.ParseFrom(cmd.Spec);
        return await ctx.Commands.RestartServicesAsync(spec.Services, ct);
    }

    public Task ResumeAsync(InstallJob job, IModuleContext ctx, CancellationToken ct) => Task.CompletedTask;
    public Task ReconcileAsync(PolicySnapshot policy, IModuleContext ctx, CancellationToken ct) => Task.CompletedTask;
}

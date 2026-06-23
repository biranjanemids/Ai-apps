using Google.Protobuf;
using Ltsc.Agent.Modules;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Ltsc.Agent.Tests;

public class InventoryAndCommandTests
{
    private static RecordingContext Ctx(FakeCommandExecutor? exec = null) =>
        new(new FakeUwf(), new FakeInstaller(), new FakeDetection(), new FakeSession(),
            commands: exec ?? new FakeCommandExecutor());

    private static CommandEnvelope Cmd(string capability, string action, ByteString? spec = null) => new()
    {
        CommandId = "c1",
        Capability = capability,
        Action = action,
        Spec = spec ?? ByteString.Empty,
    };

    [Fact]
    public async Task Inventory_Collect_ReportsNonEmptyReport()
    {
        using var ctx = Ctx();
        var module = new InventoryModule(NullLogger<InventoryModule>.Instance);

        await module.ApplyAsync(Cmd("inventory", "collect"), ctx, default);

        var report = Assert.Single(ctx.Inventories);
        Assert.False(string.IsNullOrEmpty(report.Hostname));
        Assert.True(report.CpuCount > 0);
        Assert.Equal("Succeeded", ctx.Results.Single().Status);
    }

    [Fact]
    public async Task Command_Reboot_InvokesExecutor_AndReportsSuccess()
    {
        var exec = new FakeCommandExecutor();
        using var ctx = Ctx(exec);
        var module = new CommandModule(NullLogger<CommandModule>.Instance);

        await module.ApplyAsync(Cmd("command", "reboot"), ctx, default);

        Assert.Contains("reboot", exec.Calls);
        Assert.Equal("Succeeded", ctx.Results.Single().Status);
    }

    [Fact]
    public async Task Command_RunScript_PassesSpec_AndReportsExitCode()
    {
        var exec = new FakeCommandExecutor { ScriptResult = new Ltsc.Agent.Platform.ExecResult(2, "boom") };
        using var ctx = Ctx(exec);
        var module = new CommandModule(NullLogger<CommandModule>.Instance);

        var spec = new ScriptSpec { Interpreter = "sh", Script = "echo hi", TimeoutSeconds = 5 }.ToByteString();
        await module.ApplyAsync(Cmd("command", "run_script", spec), ctx, default);

        Assert.Contains("run_script:sh", exec.Calls);
        var result = ctx.Results.Single();
        Assert.Equal("Failed", result.Status);   // non-zero exit
        Assert.Equal(2, result.ExitCode);
    }

    [Fact]
    public async Task Command_RestartServices_PassesServiceList()
    {
        var exec = new FakeCommandExecutor();
        using var ctx = Ctx(exec);
        var module = new CommandModule(NullLogger<CommandModule>.Instance);

        var spec = new RestartServicesSpec { Services = { "spooler", "ltsc-agent" } }.ToByteString();
        await module.ApplyAsync(Cmd("command", "restart_services", spec), ctx, default);

        Assert.Contains("restart_services:spooler,ltsc-agent", exec.Calls);
        Assert.Equal("Succeeded", ctx.Results.Single().Status);
    }

    [Fact]
    public async Task Command_UnknownAction_ReportsFailed()
    {
        using var ctx = Ctx();
        var module = new CommandModule(NullLogger<CommandModule>.Instance);

        await module.ApplyAsync(Cmd("command", "self_destruct"), ctx, default);

        Assert.Equal("Failed", ctx.Results.Single().Status);
    }
}

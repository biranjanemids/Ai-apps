using System.Diagnostics;
using System.Net.Sockets;
using Microsoft.Extensions.Logging;

namespace Ltsc.Agent.Platform;

public sealed record ExecResult(int ExitCode, string Output);

/// <summary>Executes remote commands on the device (design §10).</summary>
public interface IRemoteCommandExecutor
{
    Task<ExecResult> RunScriptAsync(string interpreter, string script, int timeoutSeconds, CancellationToken ct);
    Task<ExecResult> RestartServicesAsync(IReadOnlyList<string> services, CancellationToken ct);
    Task<ExecResult> RebootAsync(int delaySeconds, CancellationToken ct);
    Task<ExecResult> ShutdownAsync(int delaySeconds, CancellationToken ct);
    Task<ExecResult> CollectLogsAsync(CancellationToken ct);
    Task<ExecResult> WakeAsync(string macAddress, CancellationToken ct);
}

/// <summary>
/// Cross-platform executor (OS-aware). Script execution and service restarts run
/// for real; **power actions (reboot/shutdown) are gated** behind
/// LTSC_ALLOW_POWER=1 so demo/CI hosts are never taken down — the intent is
/// logged and reported instead. The Windows path uses shutdown.exe / sc.exe.
/// </summary>
public sealed class DefaultRemoteCommandExecutor : IRemoteCommandExecutor
{
    private readonly ILogger<DefaultRemoteCommandExecutor> _log;
    private static bool PowerAllowed => Environment.GetEnvironmentVariable("LTSC_ALLOW_POWER") == "1";

    public DefaultRemoteCommandExecutor(ILogger<DefaultRemoteCommandExecutor> log) => _log = log;

    public Task<ExecResult> RunScriptAsync(string interpreter, string script, int timeoutSeconds, CancellationToken ct)
    {
        var (file, args) = ResolveInterpreter(interpreter, script);
        return RunAsync(file, args, timeoutSeconds <= 0 ? 300 : timeoutSeconds, ct);
    }

    public async Task<ExecResult> RestartServicesAsync(IReadOnlyList<string> services, CancellationToken ct)
    {
        var output = new System.Text.StringBuilder();
        var worst = 0;
        foreach (var svc in services)
        {
            var r = OperatingSystem.IsWindows()
                ? await RunAsync("powershell", $"-NonInteractive -Command \"Restart-Service -Name '{svc}' -Force\"", 120, ct)
                : await RunAsync("systemctl", $"restart {svc}", 120, ct);
            output.AppendLine($"{svc}: exit {r.ExitCode}");
            worst = Math.Max(worst, r.ExitCode);
        }
        return new ExecResult(worst, output.ToString());
    }

    public Task<ExecResult> RebootAsync(int delaySeconds, CancellationToken ct) => Power("reboot", delaySeconds, ct);
    public Task<ExecResult> ShutdownAsync(int delaySeconds, CancellationToken ct) => Power("shutdown", delaySeconds, ct);

    public async Task<ExecResult> CollectLogsAsync(CancellationToken ct)
    {
        // Minimal portable bundle; Windows production collects Event Logs + agent logs.
        var dir = Path.Combine(Path.GetTempPath(), $"ltsc-logs-{DateTime.UtcNow:yyyyMMddHHmmss}");
        Directory.CreateDirectory(dir);
        await File.WriteAllTextAsync(Path.Combine(dir, "summary.txt"),
            $"host={Environment.MachineName}\nos={System.Runtime.InteropServices.RuntimeInformation.OSDescription}\nutc={DateTime.UtcNow:o}\n", ct);
        return new ExecResult(0, dir);
    }

    public Task<ExecResult> WakeAsync(string macAddress, CancellationToken ct)
    {
        // Wake-on-LAN magic packet (broadcast). On the target itself this is a
        // no-op; in production a peer agent on the subnet sends it (design §10).
        try
        {
            var mac = macAddress.Split(':', '-').Select(b => Convert.ToByte(b, 16)).ToArray();
            if (mac.Length != 6) return Task.FromResult(new ExecResult(1, "invalid MAC"));
            var packet = new byte[102];
            for (var i = 0; i < 6; i++) packet[i] = 0xFF;
            for (var i = 1; i <= 16; i++) Array.Copy(mac, 0, packet, i * 6, 6);
            using var udp = new UdpClient { EnableBroadcast = true };
            udp.Send(packet, packet.Length, new System.Net.IPEndPoint(System.Net.IPAddress.Broadcast, 9));
            return Task.FromResult(new ExecResult(0, $"magic packet sent to {macAddress}"));
        }
        catch (Exception ex)
        {
            return Task.FromResult(new ExecResult(1, ex.Message));
        }
    }

    private Task<ExecResult> Power(string kind, int delaySeconds, CancellationToken ct)
    {
        if (!PowerAllowed)
        {
            _log.LogWarning("{Kind} requested (delay {Delay}s) — suppressed (set LTSC_ALLOW_POWER=1 to enable)", kind, delaySeconds);
            return Task.FromResult(new ExecResult(0, $"{kind} simulated (power actions disabled)"));
        }
        if (OperatingSystem.IsWindows())
            return RunAsync("shutdown.exe", kind == "reboot" ? $"/r /t {delaySeconds}" : $"/s /t {delaySeconds}", 30, ct);
        return RunAsync("shutdown", kind == "reboot" ? $"-r +{Math.Max(delaySeconds / 60, 0)}" : $"-h +{Math.Max(delaySeconds / 60, 0)}", 30, ct);
    }

    private static (string file, string args) ResolveInterpreter(string interpreter, string script)
    {
        if (OperatingSystem.IsWindows())
            return interpreter.Equals("cmd", StringComparison.OrdinalIgnoreCase)
                ? ("cmd.exe", $"/c {script}")
                : ("powershell", $"-NonInteractive -Command \"{script.Replace("\"", "\\\"")}\"");
        return ("/bin/sh", $"-c \"{script.Replace("\"", "\\\"")}\"");
    }

    private async Task<ExecResult> RunAsync(string file, string args, int timeoutSeconds, CancellationToken ct)
    {
        try
        {
            using var p = new Process
            {
                StartInfo = new ProcessStartInfo(file, args)
                {
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                },
            };
            p.Start();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));
            var stdout = await p.StandardOutput.ReadToEndAsync(timeout.Token);
            var stderr = await p.StandardError.ReadToEndAsync(timeout.Token);
            await p.WaitForExitAsync(timeout.Token);
            var tail = (stdout + stderr);
            return new ExecResult(p.ExitCode, tail.Length > 4000 ? tail[^4000..] : tail);
        }
        catch (Exception ex)
        {
            return new ExecResult(-1, ex.Message);
        }
    }
}

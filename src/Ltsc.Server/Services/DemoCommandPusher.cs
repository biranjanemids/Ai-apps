using Google.Protobuf;
using Ltsc.Mgmt.V1;
using Ltsc.Server.Registry;

namespace Ltsc.Server.Services;

/// <summary>
/// Stands in for the JobOrchestrator (design §12). It builds one representative
/// "install" command per connected device so the agent's App-deployment state
/// machine can be exercised end-to-end. Replace with real job fan-out later.
/// </summary>
public sealed class DemoCommandPusher
{
    private readonly ConnectionRegistry _connections;
    private readonly ILogger<DemoCommandPusher> _log;

    public DemoCommandPusher(ConnectionRegistry connections, ILogger<DemoCommandPusher> log)
    {
        _connections = connections;
        _log = log;
    }

    public void ScheduleDemoInstall(string deviceId)
    {
        // Slight delay so the agent finishes wiring its stream first.
        _ = Task.Run(async () =>
        {
            await Task.Delay(TimeSpan.FromSeconds(3));

            var spec = new InstallSpec
            {
                AppId = "com.contoso.lineapp",
                Version = "2.4.0",
                Installer = new Installer
                {
                    Type = "msi",
                    ArtifactId = "artifact-lineapp-2.4.0",
                    InstallCmd = "msiexec /i lineapp.msi /qn",
                    UninstallCmd = "msiexec /x {GUID} /qn",
                    ValidExitCodes = { 0, 1641, 3010 },
                },
                Detect =
                {
                    new DetectionRule { Kind = "msi_product", Key = "{PRODUCT-GUID}", Op = "exists" },
                },
                Config =
                {
                    new ConfigTask
                    {
                        TaskId = "set-server-url",
                        Kind = "registry",
                        ApplyPayloadJson = "{\"path\":\"HKLM\\\\Software\\\\Contoso\\\\LineApp\",\"name\":\"ServerUrl\",\"value\":\"https://mgmt.contoso.local\"}",
                        Verify = new DetectionRule { Kind = "registry", Key = "HKLM\\Software\\Contoso\\LineApp\\ServerUrl", Op = "exists" },
                    },
                },
                Delivery = new Delivery { Mode = "immediate" },
                Defer = new DeferPolicy { AllowDefer = true, MaxCount = 3, MaxTotalSeconds = 72 * 3600, SnoozeStepSeconds = 3600, PromptText = "LineApp update is ready." },
                Reboot = new RebootPolicy { Required = true, AllowDefer = true, MaxTotalSeconds = 24 * 3600 },
                Uwf = new UwfPolicy { Strategy = "hybrid" },
            };

            var cmd = new CommandEnvelope
            {
                CommandId = Ulid(),
                Capability = "app",
                Action = "install",
                Spec = spec.ToByteString(),
                NotAfterUnix = DateTimeOffset.UtcNow.AddHours(24).ToUnixTimeSeconds(),
            };

            if (_connections.Send(deviceId, new ServerMessage { Command = cmd }))
                _log.LogInformation("Pushed demo install {Cmd} to {DeviceId}", cmd.CommandId, deviceId);
        });
    }

    // Minimal sortable id; swap for a real ULID library in production.
    private static string Ulid() =>
        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString("D13") + "-" + Guid.NewGuid().ToString("n")[..8];
}

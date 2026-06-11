using Google.Protobuf;
using Ltsc.Mgmt.V1;
using Ltsc.Server.Ca;
using Ltsc.Server.Registry;

namespace Ltsc.Server.Services;

/// <summary>
/// Builds, signs, and pushes commands to online devices (design §12 orchestrator
/// + §13 signing). Used by the admin console to issue remote actions. Returns
/// false if the device isn't currently connected.
/// </summary>
public sealed class CommandDispatcher
{
    private readonly DeviceRouter _router;
    private readonly CertAuthority _ca;
    private readonly ILogger<CommandDispatcher> _log;

    public CommandDispatcher(DeviceRouter router, CertAuthority ca, ILogger<CommandDispatcher> log)
    {
        _router = router;
        _ca = ca;
        _log = log;
    }

    public (bool sent, string commandId) Dispatch(string deviceId, string capability, string action, ByteString spec)
    {
        var cmd = new CommandEnvelope
        {
            CommandId = $"{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():D13}-{Guid.NewGuid():n}".Substring(0, 22),
            Capability = capability,
            Action = action,
            Spec = spec,
            NotAfterUnix = DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeSeconds(),
        };
        cmd.Signature = ByteString.CopyFrom(_ca.SignCommandPayload(key => CommandSigning.Sign(cmd, key)));

        var sent = _router.Send(deviceId, new ServerMessage { Command = cmd });
        _log.LogInformation("Dispatch {Cap}/{Action} to {Device}: {Sent}", capability, action, deviceId, sent ? "sent" : "offline");
        return (sent, cmd.CommandId);
    }
}

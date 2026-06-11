using Grpc.Core;
using Ltsc.Mgmt.V1;
using Ltsc.Server.Registry;

namespace Ltsc.Server.Services;

/// <summary>
/// Serves the effective desired-state policy for a device (design §7). The agent
/// pulls this after receiving a SyncPolicy push (or at startup) and reconciles.
/// </summary>
public sealed class PolicyService : Ltsc.Mgmt.V1.PolicyService.PolicyServiceBase
{
    private readonly DeviceRegistry _devices;
    private readonly PolicyRegistry _policies;
    private readonly ILogger<PolicyService> _log;

    public PolicyService(DeviceRegistry devices, PolicyRegistry policies, ILogger<PolicyService> log)
    {
        _devices = devices;
        _policies = policies;
        _log = log;
    }

    public override Task<PolicySnapshot> GetPolicy(GetPolicyRequest request, ServerCallContext context)
    {
        var group = _devices.TryGet(request.DeviceId, out var dev) ? dev.GroupId : "group-default";
        var snap = _policies.ForGroup(group);
        _log.LogInformation("GetPolicy {Device} group={Group} version={Version} ({Profiles} profiles)",
            request.DeviceId, group, snap.Version, snap.Profiles.Count);
        return Task.FromResult(snap);
    }
}

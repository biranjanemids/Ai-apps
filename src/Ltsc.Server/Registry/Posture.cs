using Ltsc.Mgmt.V1;

namespace Ltsc.Server.Registry;

/// <summary>
/// Zero-trust continuous posture (futuristic use case). A device must keep proving
/// it's trustworthy on every heartbeat — write filter on, in policy, not in a
/// critical health state. Violations quarantine the device (flag + alert) and, if
/// configured, trigger certificate revocation. Composes the health + revocation
/// engines into continuous conditional access.
/// </summary>
public static class Posture
{
    public sealed record Result(bool Compliant, IReadOnlyList<string> Violations);

    public static Result Evaluate(Health? h, bool inPolicy, FleetHealth.Result health)
    {
        var v = new List<string>();
        if (h is { UwfEnabled: false }) v.Add("write filter disabled");
        if (!inPolicy) v.Add("policy drift");
        if (health.Band == "critical") v.Add("health critical");
        return new Result(v.Count == 0, v);
    }
}

using Ltsc.Mgmt.V1;

namespace Ltsc.Agent.Platform;

/// <summary>Outcome of reconciling one configuration profile (design §7).</summary>
public sealed record ReconcileResult(string ProfileId, bool Drifted, bool Applied, bool Verified, string Detail)
{
    public static ReconcileResult NoDrift(string id) => new(id, Drifted: false, Applied: false, Verified: true, "in desired state");
    public static ReconcileResult AppliedOk(string id, string detail) => new(id, Drifted: true, Applied: true, Verified: true, detail);
    public static ReconcileResult Failed(string id, string detail) => new(id, Drifted: true, Applied: true, Verified: false, detail);
}

/// <summary>
/// Applies one kind of configuration profile idempotently (design §7). Drift
/// detection (<see cref="IsInDesiredState"/>) is separated from the mutation
/// (<see cref="Apply"/>) so the module only enters a UWF servicing bracket when
/// there is actually drift to write.
/// </summary>
public interface ISettingApplier
{
    /// <summary>The ConfigProfile.body case this applier handles.</summary>
    ConfigProfile.BodyOneofCase Kind { get; }

    /// <summary>Whether applying this profile is a persistent write that must be UWF-bracketed.</summary>
    bool RequiresPersistence { get; }

    /// <summary>Read-only check: is the device already in the profile's desired state?</summary>
    bool IsInDesiredState(ConfigProfile profile);

    /// <summary>Perform the change. Called only when <see cref="IsInDesiredState"/> was false.</summary>
    ReconcileResult Apply(ConfigProfile profile);
}

using Ltsc.Mgmt.V1;

namespace Ltsc.Server.Registry;

/// <summary>
/// Digital-twin / what-if simulation (futuristic use case). Computes the impact of
/// a proposed PolicySnapshot against the current one — which profiles are added,
/// removed, or changed; whether it forces a reboot (persistent UWF/kiosk changes);
/// and how many devices it touches — so an admin sees the blast radius BEFORE
/// applying. Pure + deterministic.
/// </summary>
public static class PolicySimulator
{
    public sealed record Impact(
        string CurrentVersion, string CurrentHash, string ProposedHash, bool Changed,
        IReadOnlyList<string> Added, IReadOnlyList<string> Removed, IReadOnlyList<string> Modified,
        bool RequiresReboot, int AffectedDevices);

    public static Impact Simulate(PolicySnapshot current, PolicySnapshot proposed, int devicesInGroup)
    {
        var cur = current.Profiles.ToDictionary(p => p.ProfileId);
        var prop = proposed.Profiles.ToDictionary(p => p.ProfileId);

        var added = prop.Keys.Except(cur.Keys).OrderBy(x => x).ToList();
        var removed = cur.Keys.Except(prop.Keys).OrderBy(x => x).ToList();
        var modified = prop.Keys.Intersect(cur.Keys).Where(k => !cur[k].Equals(prop[k])).OrderBy(x => x).ToList();

        var changed = added.Count + removed.Count + modified.Count > 0;
        // Persistent lockdown changes (UWF/kiosk) require a servicing reboot (§8.6).
        bool reboot = added.Concat(modified).Any(id =>
            prop[id].BodyCase is ConfigProfile.BodyOneofCase.Uwf or ConfigProfile.BodyOneofCase.Kiosk);

        return new Impact(current.Version, current.ContentHash, PolicyRegistry.Hash(proposed),
            changed, added, removed, modified, reboot, changed ? devicesInGroup : 0);
    }
}

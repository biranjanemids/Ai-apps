using System.Security.Cryptography;
using Google.Protobuf;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging;

namespace Ltsc.Agent.Platform;

/// <summary>
/// Cross-platform stub applier so the reconcile loop runs and is testable
/// off-Windows. It remembers the last-applied content per profile id, so a
/// second reconcile of the same profile reports no drift (idempotent). Real
/// Windows appliers live under Platform/Windows and replace these on Windows.
/// </summary>
public class StubSettingApplier : ISettingApplier
{
    private readonly Dictionary<string, string> _applied = new();
    private readonly ILogger? _log;

    public ConfigProfile.BodyOneofCase Kind { get; }
    public bool RequiresPersistence { get; }

    public StubSettingApplier(ConfigProfile.BodyOneofCase kind, bool requiresPersistence, ILogger? log = null)
    {
        Kind = kind;
        RequiresPersistence = requiresPersistence;
        _log = log;
    }

    public bool IsInDesiredState(ConfigProfile profile) =>
        _applied.TryGetValue(profile.ProfileId, out var prev) && prev == Hash(profile);

    public ReconcileResult Apply(ConfigProfile profile)
    {
        _applied[profile.ProfileId] = Hash(profile);
        _log?.LogInformation("[stub] applied {Kind} profile {Id}", Kind, profile.ProfileId);
        return ReconcileResult.AppliedOk(profile.ProfileId, $"[stub] applied {Kind}");
    }

    private static string Hash(ConfigProfile p) => Convert.ToHexString(SHA256.HashData(p.ToByteArray()));
}

using Ltsc.Agent.Models;
using Ltsc.Agent.Platform;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging;

namespace Ltsc.Agent.Modules;

/// <summary>
/// Configuration / manageability subsystem (design §7, §9). Brings the device to
/// the desired state described by a PolicySnapshot via idempotent per-profile
/// appliers, entering a single UWF servicing bracket only when drift requires a
/// persistent write, and reporting per-profile status. Also handles a one-off
/// "apply_config" command that carries a snapshot inline.
/// </summary>
public sealed class ConfigModule : IManagementModule
{
    private readonly Dictionary<ConfigProfile.BodyOneofCase, ISettingApplier> _appliers;
    private readonly ILogger<ConfigModule> _log;

    public string Capability => "config";

    public ConfigModule(IEnumerable<ISettingApplier> appliers, ILogger<ConfigModule> log)
    {
        _appliers = appliers.ToDictionary(a => a.Kind);
        _log = log;
    }

    public async Task ApplyAsync(CommandEnvelope cmd, IModuleContext ctx, CancellationToken ct)
    {
        if (cmd.Action != "apply_config")
        {
            _log.LogWarning("ConfigModule: unsupported action {Action}", cmd.Action);
            return;
        }
        await ReconcileAsync(PolicySnapshot.Parser.ParseFrom(cmd.Spec), ctx, ct);
    }

    public Task ResumeAsync(InstallJob job, IModuleContext ctx, CancellationToken ct) => Task.CompletedTask;

    public async Task ReconcileAsync(PolicySnapshot policy, IModuleContext ctx, CancellationToken ct)
    {
        var jobId = $"policy:{policy.Version}";

        // 1. Drift detection (read-only) — figure out what actually needs writing.
        var pending = new List<(ConfigProfile profile, ISettingApplier applier)>();
        foreach (var profile in policy.Profiles)
        {
            if (!_appliers.TryGetValue(profile.BodyCase, out var applier))
            {
                await ctx.ReportEventAsync("config.unknown_profile", "warn",
                    $"{{\"id\":\"{profile.ProfileId}\",\"kind\":\"{profile.BodyCase}\"}}");
                continue;
            }
            if (applier.IsInDesiredState(profile))
                await ctx.ReportProgressAsync(jobId, $"{profile.BodyCase}:{profile.ProfileId}", 0, "in desired state");
            else
                pending.Add((profile, applier));
        }

        if (pending.Count == 0)
        {
            ctx.Store.SetIdentity("policy_version", policy.ContentHash);
            await ctx.ReportProgressAsync(jobId, "Reconciled", 100, "no drift");
            await ctx.ReportResultAsync(Result(jobId, "Succeeded", ctx.Uwf.IsEnabled(), "no drift; already in desired state"));
            return;
        }

        // 2. One UWF servicing bracket if any pending change is persistent (design §8.6).
        ServicingPlan? plan = null;
        var touched = pending.Select(p => p.profile.ProfileId).ToArray();
        if (pending.Any(p => p.applier.RequiresPersistence))
            plan = ctx.Uwf.EnterServicing(new UwfPolicy { Strategy = "always_disable" }, touched);

        try
        {
            // 3. Apply only the drifted profiles, idempotently.
            var applied = 0;
            for (var i = 0; i < pending.Count; i++)
            {
                ct.ThrowIfCancellationRequested();
                var (profile, applier) = pending[i];
                var r = applier.Apply(profile);
                var pct = (int)((i + 1) / (double)pending.Count * 90);
                await ctx.ReportProgressAsync(jobId, $"{profile.BodyCase}:{profile.ProfileId}", pct, r.Detail);

                if (!r.Verified)
                {
                    await ctx.ReportEventAsync("config.profile_failed", "error",
                        $"{{\"id\":\"{profile.ProfileId}\",\"detail\":\"{r.Detail}\"}}");
                    Rollback(ctx, plan);
                    await ctx.ReportResultAsync(Result(jobId, "Failed", ctx.Uwf.IsEnabled(),
                        $"profile {profile.ProfileId} failed: {r.Detail}"));
                    return; // never report green on a failed profile
                }
                applied++;
            }

            // 4. Restore / confirm UWF protection (design §8.6).
            if (plan is not null && !ctx.Uwf.ExitServicing(plan))
            {
                await ctx.ReportEventAsync("uwf.reenable_failed", "error", "{}");
                await ctx.ReportResultAsync(Result(jobId, "Failed", false, "UWF failed to re-enable; failing closed"));
                return;
            }

            ctx.Store.SetIdentity("policy_version", policy.ContentHash);
            await ctx.ReportProgressAsync(jobId, "Reconciled", 100, $"{applied} applied");
            await ctx.ReportResultAsync(Result(jobId, "Succeeded", ctx.Uwf.IsEnabled(),
                $"policy {policy.Version} reconciled ({applied} applied)"));
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Reconcile of policy {Version} failed", policy.Version);
            Rollback(ctx, plan);
            await ctx.ReportResultAsync(Result(jobId, "Failed", ctx.Uwf.IsEnabled(), ex.Message));
        }
    }

    private static void Rollback(IModuleContext ctx, ServicingPlan? plan)
    {
        if (plan is not null) ctx.Uwf.Rollback(plan);
    }

    private static CommandResult Result(string jobId, string status, bool uwfReenabled, string detail) => new()
    {
        CommandId = jobId,
        Status = status,
        UwfReenabled = uwfReenabled,
        StdoutTail = detail,
    };
}

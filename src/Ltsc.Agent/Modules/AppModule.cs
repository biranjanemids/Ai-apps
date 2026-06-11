using Ltsc.Agent.Models;
using Ltsc.Agent.Platform;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging;

namespace Ltsc.Agent.Modules;

/// <summary>
/// App-deployment subsystem (design §8). Implements the resumable, write-filter-
/// safe, restart-aware install state machine with scheduling, user deferral, and
/// per-stage status reporting. State is persisted to LocalStore on every
/// transition so an install resumes correctly across reboots.
/// </summary>
public sealed class AppModule : IManagementModule
{
    private readonly ILogger<AppModule> _log;
    public string Capability => "app";

    public AppModule(ILogger<AppModule> log) => _log = log;

    public async Task ApplyAsync(CommandEnvelope cmd, IModuleContext ctx, CancellationToken ct)
    {
        if (cmd.Action != "install")
        {
            _log.LogWarning("AppModule: unsupported action {Action}", cmd.Action);
            return;
        }

        var job = new InstallJob { CommandId = cmd.CommandId, Spec = cmd.Spec.ToByteArray() };
        ctx.Store.SaveJob(job);
        await RunAsync(job, ctx, ct);
    }

    public Task ResumeAsync(InstallJob job, IModuleContext ctx, CancellationToken ct)
    {
        _log.LogInformation("Resuming install {Cmd} at stage {State}", job.CommandId, job.State);
        return RunAsync(job, ctx, ct);
    }

    // App deployment is command-driven, not policy-driven.
    public Task ReconcileAsync(PolicySnapshot policy, IModuleContext ctx, CancellationToken ct) => Task.CompletedTask;

    private async Task RunAsync(InstallJob job, IModuleContext ctx, CancellationToken ct)
    {
        var spec = InstallSpec.Parser.ParseFrom(job.Spec);
        ServicingPlan? plan = null;
        var configResults = new List<ConfigResult>();

        // Resume shortcut (design §8.4): a job persisted at PostRebootVerify was
        // already installed, configured and verified before the reboot — just
        // confirm detection and finish, without re-running the installer.
        if (job.State == InstallState.PostRebootVerify)
        {
            await Transition(job, ctx, InstallState.PostRebootVerify, 96, "verifying after reboot (resumed)");
            if (spec.Detect.Count > 0 && !spec.Detect.All(ctx.Detection.Evaluate))
            {
                await Fail(job, ctx, plan: null, exit: 0, configResults, "post-reboot detection failed");
                return;
            }
            await Succeed(job, ctx, exit: 0, rebootState: "rebooted", uwfReenabled: ctx.Uwf.IsEnabled(),
                configResults, detail: "resumed after reboot");
            return;
        }

        try
        {
            // ---- 1. Delivery scheduling (§8.2) --------------------------------
            await Transition(job, ctx, InstallState.Scheduled, 5, $"delivery={spec.Delivery?.Mode}");
            if (!IsDeliveryEligible(spec.Delivery, out var waitReason))
            {
                await Transition(job, ctx, InstallState.WaitingWindow, 5, waitReason);
                // A real agent re-evaluates on the next scheduler tick; the job
                // stays persisted. For the scaffold we stop here.
                return;
            }

            // ---- 2. User deferral, capped by count AND max time (§8.3) --------
            if (!await ResolveDeferralAsync(job, ctx, spec.Defer, ct))
            {
                await Transition(job, ctx, InstallState.AwaitingUserDefer, 5,
                    $"deferred {job.DeferCount}/{spec.Defer.MaxCount} until {job.EffectiveDeadlineUtc:o}");
                return; // re-prompted on next tick
            }

            // ---- 3. Pre-check: skip if already installed (§8.4) ---------------
            await Transition(job, ctx, InstallState.PreCheck, 15, "evaluating detection rules");
            if (spec.Detect.Count > 0 && spec.Detect.All(ctx.Detection.Evaluate))
            {
                await Transition(job, ctx, InstallState.AlreadyInstalled, 100, "already present");
                await Succeed(job, ctx, exit: 0, rebootState: "none", uwfReenabled: ctx.Uwf.IsEnabled(), configResults,
                    detail: "already installed");
                return;
            }

            // ---- 4. Enter servicing: hybrid UWF strategy (§8.6) ---------------
            job.UwfWasEnabled = ctx.Uwf.IsEnabled();
            await Transition(job, ctx, InstallState.EnterServicing, 25, "preparing write filter");
            var touched = TouchedPaths(spec);
            plan = ctx.Uwf.EnterServicing(spec.Uwf, touched);
            await ctx.ReportEventAsync("install.servicing", "info",
                $"{{\"strategy\":\"{plan.Strategy}\",\"reboot\":{plan.RebootRequired.ToString().ToLower()}}}");

            // ---- 5. Download + verify artifact (§8.4, §8.6) -------------------
            await Transition(job, ctx, InstallState.Downloading, 40, $"artifact {spec.Installer.ArtifactId}");
            var artifactPath = "(none)";
            if (!string.IsNullOrEmpty(spec.Installer.ArtifactId))
            {
                try
                {
                    artifactPath = await ctx.Artifacts.FetchAsync(
                        spec.Installer.ArtifactId, spec.Installer.Sha256.ToByteArray(), ct);
                }
                catch (InvalidDataException ex)
                {
                    // Integrity failure: never run unverified bytes.
                    await ctx.ReportEventAsync("artifact.integrity_failed", "error",
                        $"{{\"artifact\":\"{spec.Installer.ArtifactId}\"}}");
                    await Fail(job, ctx, plan, exit: -1, configResults, ex.Message);
                    return;
                }
            }

            // ---- 6. Install + map exit code (§8.4) ----------------------------
            await Transition(job, ctx, InstallState.Installing, 60, spec.Installer.InstallCmd);
            var run = await ctx.Installer.RunAsync(spec.Installer, artifactPath, ct);
            var valid = spec.Installer.ValidExitCodes.Count == 0 || spec.Installer.ValidExitCodes.Contains(run.ExitCode);
            if (!valid)
            {
                await Fail(job, ctx, plan, run.ExitCode, configResults, $"installer exit {run.ExitCode} not in valid set");
                return;
            }
            if (ctx.Detection is StubDetectionProbe stub) stub.MarkInstalled();

            // ---- 7. Apply + VERIFY app configuration (§8.5) -------------------
            await Transition(job, ctx, InstallState.ConfiguringApp, 75, $"{spec.Config.Count} config task(s)");
            foreach (var task in spec.Config)
            {
                // (Scaffold: applying the payload is a stub; verify uses the probe.)
                var verified = task.Verify is null || ctx.Detection.Evaluate(task.Verify);
                configResults.Add(new ConfigResult { TaskId = task.TaskId, Applied = true, Verified = verified, Detail = task.Kind });
                if (!verified)
                {
                    await Fail(job, ctx, plan, run.ExitCode, configResults, $"config task {task.TaskId} failed verification");
                    return; // never report green on misconfigured
                }
            }

            // ---- 8. Verify install (§8.4) -------------------------------------
            await Transition(job, ctx, InstallState.Verifying, 85, "re-running detection");
            if (spec.Detect.Count > 0 && !spec.Detect.All(ctx.Detection.Evaluate))
            {
                await Fail(job, ctx, plan, run.ExitCode, configResults, "post-install detection failed");
                return;
            }

            // ---- 9. Exit servicing: re-enable / confirm UWF (§8.6) ------------
            await Transition(job, ctx, InstallState.ExitServicing, 90, "restoring write filter");
            var uwfReenabled = ctx.Uwf.ExitServicing(plan);
            if (job.UwfWasEnabled && !uwfReenabled)
            {
                await ctx.ReportEventAsync("uwf.reenable_failed", "error", "{}");
                await Fail(job, ctx, plan, run.ExitCode, configResults, "UWF failed to re-enable; failing closed");
                return;
            }

            // ---- 10. Reboot handling: separate deferral + deadline (§8.4) -----
            var rebootState = "none";
            if (run.RebootRequired || spec.Reboot.Force)
            {
                if (spec.Reboot.RestartServices.Count > 0)
                {
                    // Restart-aware: a service bounce avoids a full OS reboot.
                    await Transition(job, ctx, InstallState.PostRebootVerify, 95,
                        $"restarting services: {string.Join(",", spec.Reboot.RestartServices)}");
                    rebootState = "service_restarted";
                }
                else
                {
                    job.RebootPending = true;
                    await Transition(job, ctx, InstallState.PendingReboot, 92, "reboot required");
                    // Report the interim status the console shows for pending reboots.
                    await ctx.ReportResultAsync(Result(job.CommandId, "InstalledPendingReboot",
                        run.ExitCode, "pending", uwfReenabled, run.StdoutTail, configResults));

                    var deadline = DateTimeOffset.UtcNow.AddSeconds(Math.Max(spec.Reboot.MaxTotalSeconds, 0));
                    var rebootNow = !spec.Reboot.AllowDefer
                        || !ctx.Session.HasInteractiveSession()
                        || await ctx.Session.PromptRebootAsync(deadline, ct);

                    if (!rebootNow)
                    {
                        await ctx.ReportEventAsync("reboot.deferred", "info", $"{{\"deadline\":\"{deadline:o}\"}}");
                        return; // job stays pending; resumes after the eventual reboot
                    }

                    // Real agent reboots here; on next start ResumeAsync lands at PostRebootVerify.
                    await Transition(job, ctx, InstallState.PostRebootVerify, 96, "verifying after reboot");
                    rebootState = "rebooted";
                }
            }

            await Succeed(job, ctx, run.ExitCode, rebootState, uwfReenabled, configResults, run.StdoutTail);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Install {Cmd} threw", job.CommandId);
            await Fail(job, ctx, plan, exit: -1, configResults, ex.Message);
        }
    }

    // ---- helpers -----------------------------------------------------------

    private static bool IsDeliveryEligible(Delivery? d, out string reason)
    {
        reason = "";
        if (d is null || d.Mode == "immediate") return true;
        if (d.Mode == "scheduled")
        {
            if (d.NotBefore is not null && d.NotBefore.ToDateTimeOffset() > DateTimeOffset.UtcNow)
            {
                reason = $"scheduled for {d.NotBefore.ToDateTimeOffset():o}";
                return false;
            }
            return true;
        }
        if (d.Mode == "maintenance_window")
        {
            if (InWindow(d.Window)) return true;
            reason = "outside maintenance window";
            return false;
        }
        return true;
    }

    private static bool InWindow(MaintenanceWindow? w)
    {
        if (w is null) return true;
        var now = DateTime.Now; // device-local
        if (w.Days.Count > 0 && !w.Days.Contains((int)now.DayOfWeek)) return false;
        if (TimeOnly.TryParse(w.StartLocal, out var start) && TimeOnly.TryParse(w.EndLocal, out var end))
        {
            var t = TimeOnly.FromDateTime(now);
            return start <= end ? t >= start && t <= end : t >= start || t <= end;
        }
        return true;
    }

    /// <summary>Returns true to proceed; false if the user snoozed and we are still under budget.</summary>
    private async Task<bool> ResolveDeferralAsync(InstallJob job, IModuleContext ctx, DeferPolicy? policy, CancellationToken ct)
    {
        if (policy is null || !policy.AllowDefer || !ctx.Session.HasInteractiveSession())
            return true; // headless / kiosk / no deferral -> install now

        var maxTotal = TimeSpan.FromSeconds(Math.Max(policy.MaxTotalSeconds, 0));
        var hardDeadline = job.FirstEligibleUtc + maxTotal;

        // Forced once budget is exhausted by count OR wall-clock time.
        if (job.DeferCount >= policy.MaxCount || DateTimeOffset.UtcNow >= hardDeadline)
        {
            await ctx.ReportEventAsync("install.defer_exhausted", "info",
                $"{{\"count\":{job.DeferCount},\"deadline\":\"{hardDeadline:o}\"}}");
            return true;
        }

        var snoozeRemaining = policy.MaxCount - job.DeferCount;
        var proceed = await ctx.Session.PromptInstallAsync(policy.PromptText, snoozeRemaining, hardDeadline, ct);
        if (proceed) return true;

        job.DeferCount++;
        var snooze = TimeSpan.FromSeconds(Math.Max(policy.SnoozeStepSeconds, 0));
        job.EffectiveDeadlineUtc = Min(DateTimeOffset.UtcNow + snooze, hardDeadline);
        ctx.Store.SaveJob(job);
        await ctx.ReportEventAsync("install.deferred", "info",
            $"{{\"count\":{job.DeferCount},\"next\":\"{job.EffectiveDeadlineUtc:o}\"}}");
        return false;
    }

    private static IReadOnlyList<string> TouchedPaths(InstallSpec spec)
    {
        // Best-effort hint for the UWF hybrid decision (§8.6).
        var paths = new List<string> { "C:\\Program Files" };
        foreach (var c in spec.Config)
            if (c.Verify is not null && !string.IsNullOrEmpty(c.Verify.Key))
                paths.Add(c.Verify.Key);
        return paths;
    }

    private async Task Transition(InstallJob job, IModuleContext ctx, InstallState state, int pct, string detail)
    {
        job.State = state;
        job.LastDetail = detail;
        ctx.Store.SaveJob(job);
        await ctx.ReportProgressAsync(job.CommandId, state.ToString(), pct, detail);
    }

    private async Task Succeed(InstallJob job, IModuleContext ctx, int exit, string rebootState,
        bool uwfReenabled, List<ConfigResult> cfg, string detail)
    {
        await Transition(job, ctx, InstallState.Succeeded, 100, detail);
        await ctx.ReportResultAsync(Result(job.CommandId, "Succeeded", exit, rebootState, uwfReenabled, detail, cfg));
        ctx.Store.DeleteJob(job.CommandId);
    }

    private async Task Fail(InstallJob job, IModuleContext ctx, ServicingPlan? plan, int exit,
        List<ConfigResult> cfg, string detail)
    {
        if (plan is not null) ctx.Uwf.Rollback(plan); // never leave the device unprotected (§8.6)
        await Transition(job, ctx, InstallState.RolledBack, 100, detail);
        await ctx.ReportResultAsync(Result(job.CommandId, "RolledBack", exit, "none", ctx.Uwf.IsEnabled(), detail, cfg));
        ctx.Store.DeleteJob(job.CommandId);
    }

    private static CommandResult Result(string commandId, string status, int exit, string rebootState,
        bool uwfReenabled, string stdoutTail, List<ConfigResult> cfg)
    {
        var r = new CommandResult
        {
            CommandId = commandId,
            Status = status,
            ExitCode = exit,
            RebootState = rebootState,
            UwfReenabled = uwfReenabled,
            StdoutTail = stdoutTail,
        };
        r.ConfigResults.AddRange(cfg);
        return r;
    }

    private static DateTimeOffset Min(DateTimeOffset a, DateTimeOffset b) => a < b ? a : b;
}

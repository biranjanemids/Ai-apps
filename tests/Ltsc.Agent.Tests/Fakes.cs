using Ltsc.Agent.Models;
using Ltsc.Agent.Modules;
using Ltsc.Agent.Platform;
using Ltsc.Agent.Storage;
using Ltsc.Mgmt.V1;

namespace Ltsc.Agent.Tests;

/// <summary>Controllable write filter. Records whether servicing rolled back.</summary>
public sealed class FakeUwf : IWriteFilterGuard
{
    public bool Enabled = true;
    public ServicingStrategy Strategy = ServicingStrategy.DisableCycle;
    public bool ReenableSucceeds = true;
    public bool RollbackCalled { get; private set; }
    public int EnterCount { get; private set; }

    public bool IsEnabled() => Enabled;

    public ServicingPlan EnterServicing(UwfPolicy policy, IReadOnlyList<string> touchedPaths)
    {
        EnterCount++;
        return new ServicingPlan(Strategy, RebootRequired: false);
    }

    public bool ExitServicing(ServicingPlan plan) => ReenableSucceeds;
    public void Rollback(ServicingPlan plan) => RollbackCalled = true;
}

/// <summary>Installer whose exit code is configurable; runs an optional side effect.</summary>
public sealed class FakeInstaller : IInstallerRunner
{
    public int ExitCode = 0;
    public bool RebootRequired;
    public Action? OnRun;          // e.g. flip detection to "installed"
    public Exception? Throw;
    public int CallCount { get; private set; }

    public Task<InstallerResult> RunAsync(Installer installer, string artifactPath, CancellationToken ct)
    {
        CallCount++;
        if (Throw is not null) throw Throw;
        OnRun?.Invoke();
        return Task.FromResult(new InstallerResult(ExitCode, RebootRequired, $"ran exit {ExitCode}"));
    }
}

/// <summary>Detection that reflects a single mutable "installed" flag.</summary>
public sealed class FakeDetection : IDetectionProbe
{
    public bool Installed;
    public bool Evaluate(DetectionRule rule) => Installed;
}

/// <summary>Session UI with scriptable interactivity and prompt answers.</summary>
public sealed class FakeSession : ISessionUi
{
    public bool Interactive;
    public bool InstallProceed = true;
    public bool RebootProceed = true;

    public bool ShadowConsent = true;

    public bool HasInteractiveSession() => Interactive;
    public Task<bool> PromptInstallAsync(string text, int snoozeRemaining, DateTimeOffset deadline, CancellationToken ct) => Task.FromResult(InstallProceed);
    public Task<bool> PromptRebootAsync(DateTimeOffset deadline, CancellationToken ct) => Task.FromResult(RebootProceed);
    public Task<bool> PromptShadowConsentAsync(string requester, CancellationToken ct) => Task.FromResult(ShadowConsent);
}

/// <summary>Artifact fetcher with a scriptable integrity failure.</summary>
public sealed class FakeArtifactFetcher : IArtifactFetcher
{
    public bool FailIntegrity;
    public List<string> Fetched { get; } = new();

    public Task<string> FetchAsync(string artifactId, byte[] expectedSha256, CancellationToken ct)
    {
        if (FailIntegrity)
            throw new InvalidDataException($"artifact {artifactId}: SHA-256 mismatch; refusing to install");
        Fetched.Add(artifactId);
        return Task.FromResult($"/tmp/{artifactId}");
    }
}

/// <summary>IModuleContext that records everything the module reports.</summary>
public sealed class RecordingContext : IModuleContext, IDisposable
{
    public IWriteFilterGuard Uwf { get; }
    public IInstallerRunner Installer { get; }
    public IDetectionProbe Detection { get; }
    public ISessionUi Session { get; }
    public IArtifactFetcher Artifacts { get; }
    public IArtifactUploader Uploads { get; }
    public IInventoryCollector Inventory { get; }
    public IRemoteCommandExecutor Commands { get; }
    public IOsUpdateManager OsUpdates { get; }
    public IImagingEngine Imaging { get; }
    public IScreenCapturer Screen { get; }
    public IShadowUplink Shadow { get; }
    public LocalStore Store { get; }

    public List<(string CommandId, string State, int Pct, string Detail)> Progress { get; } = new();
    public List<CommandResult> Results { get; } = new();
    public List<(string Type, string Severity, string Json)> Events { get; } = new();
    public List<InventoryReport> Inventories { get; } = new();

    public RecordingContext(IWriteFilterGuard uwf, IInstallerRunner installer, IDetectionProbe detection,
        ISessionUi session, IArtifactFetcher? artifacts = null,
        IInventoryCollector? inventory = null, IRemoteCommandExecutor? commands = null,
        IOsUpdateManager? osUpdates = null, IImagingEngine? imaging = null, IArtifactUploader? uploads = null,
        IScreenCapturer? screen = null, IShadowUplink? shadow = null)
    {
        Uwf = uwf;
        Installer = installer;
        Detection = detection;
        Session = session;
        Artifacts = artifacts ?? new FakeArtifactFetcher();
        Uploads = uploads ?? new FakeArtifactUploader();
        Inventory = inventory ?? new DefaultInventoryCollector();
        Commands = commands ?? new FakeCommandExecutor();
        OsUpdates = osUpdates ?? new FakeOsUpdateManager();
        Imaging = imaging ?? new FakeImagingEngine();
        Screen = screen ?? new DefaultScreenCapturer();
        Shadow = shadow ?? new FakeShadowUplink();
        // Each context gets its own private in-memory store.
        Store = new LocalStore($"file:{Guid.NewGuid():n}?mode=memory&cache=shared");
    }

    public Task ReportProgressAsync(string commandId, string state, int percent, string detail)
    {
        Progress.Add((commandId, state, percent, detail));
        return Task.CompletedTask;
    }

    public Task ReportResultAsync(CommandResult result)
    {
        Results.Add(result);
        return Task.CompletedTask;
    }

    public Task ReportEventAsync(string type, string severity, string payloadJson)
    {
        Events.Add((type, severity, payloadJson));
        return Task.CompletedTask;
    }

    public Task ReportInventoryAsync(InventoryReport report)
    {
        Inventories.Add(report);
        return Task.CompletedTask;
    }

    public void Dispose() => Store.Dispose();
}

/// <summary>Remote command executor that records calls and returns scripted results.</summary>
public sealed class FakeCommandExecutor : IRemoteCommandExecutor
{
    public List<string> Calls { get; } = new();
    public ExecResult ScriptResult = new(0, "ok");

    public Task<ExecResult> RunScriptAsync(string interpreter, string script, int timeoutSeconds, CancellationToken ct)
    { Calls.Add($"run_script:{interpreter}"); return Task.FromResult(ScriptResult); }
    public Task<ExecResult> RestartServicesAsync(IReadOnlyList<string> services, CancellationToken ct)
    { Calls.Add($"restart_services:{string.Join(',', services)}"); return Task.FromResult(new ExecResult(0, "restarted")); }
    public Task<ExecResult> RebootAsync(int delaySeconds, CancellationToken ct)
    { Calls.Add("reboot"); return Task.FromResult(new ExecResult(0, "reboot")); }
    public Task<ExecResult> ShutdownAsync(int delaySeconds, CancellationToken ct)
    { Calls.Add("shutdown"); return Task.FromResult(new ExecResult(0, "shutdown")); }
    public Task<ExecResult> CollectLogsAsync(CancellationToken ct)
    { Calls.Add("collect_logs"); return Task.FromResult(new ExecResult(0, "/tmp/logs")); }
    public Task<ExecResult> WakeAsync(string macAddress, CancellationToken ct)
    { Calls.Add($"wake:{macAddress}"); return Task.FromResult(new ExecResult(0, "sent")); }
}

/// <summary>OS update manager with scriptable scan results.</summary>
public sealed class FakeOsUpdateManager : IOsUpdateManager
{
    public List<UpdateInfo> Available { get; set; } = new()
    {
        new UpdateInfo { UpdateId = "u1", Title = "CU", Kb = "KB1", RebootRequired = true },
        new UpdateInfo { UpdateId = "u2", Title = "Defs", Kb = "KB2", RebootRequired = false },
    };
    public int InstalledCount { get; private set; }

    public Task<IReadOnlyList<UpdateInfo>> ScanAsync(bool includeFeatureUpdates, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<UpdateInfo>>(Available);

    public Task<UpdateInstallResult> InstallAsync(IReadOnlyList<UpdateInfo> updates, CancellationToken ct)
    {
        InstalledCount = updates.Count;
        return Task.FromResult(new UpdateInstallResult(updates.Count, updates.Any(u => u.RebootRequired), $"installed {updates.Count}"));
    }
}

/// <summary>Imaging engine recording capture/apply, with a configurable model.</summary>
public sealed class FakeImagingEngine : IImagingEngine
{
    public string Model { get; set; } = "GenericThinClient";
    public bool ApplyCalled { get; private set; }
    public bool CaptureCalled { get; private set; }

    public Task<string> CaptureAsync(string format, string targetDrive, CancellationToken ct)
    { CaptureCalled = true; return Task.FromResult($"/tmp/capture.{format}"); }

    public Task<bool> ApplyAsync(string imagePath, string format, string wipePolicy, CancellationToken ct)
    { ApplyCalled = true; return Task.FromResult(true); }
}

public sealed class FakeArtifactUploader : IArtifactUploader
{
    public List<string> Uploaded { get; } = new();
    public Task<string> UploadAsync(string path, CancellationToken ct)
    { Uploaded.Add(path); return Task.FromResult("uploaded-artifact-id"); }
}

public sealed class FakeShadowUplink : IShadowUplink
{
    public int Calls { get; private set; }
    public Task<int> RunAsync(IScreenCapturer capturer, string sessionId, int maxFrames, int fps, CancellationToken ct)
    { Calls++; return Task.FromResult(maxFrames); }
}

/// <summary>Config setting applier with scriptable drift / failure, recording applies.</summary>
public sealed class FakeApplier : ISettingApplier
{
    public ConfigProfile.BodyOneofCase Kind { get; }
    public bool RequiresPersistence { get; }
    public bool InDesiredState;     // controls drift detection
    public bool FailOnApply;
    public int ApplyCount { get; private set; }

    public FakeApplier(ConfigProfile.BodyOneofCase kind, bool persist = false)
    {
        Kind = kind;
        RequiresPersistence = persist;
    }

    public bool IsInDesiredState(ConfigProfile profile) => InDesiredState;

    public ReconcileResult Apply(ConfigProfile profile)
    {
        ApplyCount++;
        if (FailOnApply) return ReconcileResult.Failed(profile.ProfileId, "boom");
        InDesiredState = true;      // converged after applying
        return ReconcileResult.AppliedOk(profile.ProfileId, "ok");
    }
}

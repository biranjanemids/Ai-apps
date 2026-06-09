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

    public bool HasInteractiveSession() => Interactive;
    public Task<bool> PromptInstallAsync(string text, int snoozeRemaining, DateTimeOffset deadline, CancellationToken ct) => Task.FromResult(InstallProceed);
    public Task<bool> PromptRebootAsync(DateTimeOffset deadline, CancellationToken ct) => Task.FromResult(RebootProceed);
}

/// <summary>IModuleContext that records everything the module reports.</summary>
public sealed class RecordingContext : IModuleContext, IDisposable
{
    public IWriteFilterGuard Uwf { get; }
    public IInstallerRunner Installer { get; }
    public IDetectionProbe Detection { get; }
    public ISessionUi Session { get; }
    public LocalStore Store { get; }

    public List<(string CommandId, InstallState State, int Pct, string Detail)> Progress { get; } = new();
    public List<CommandResult> Results { get; } = new();
    public List<(string Type, string Severity, string Json)> Events { get; } = new();

    public RecordingContext(IWriteFilterGuard uwf, IInstallerRunner installer, IDetectionProbe detection, ISessionUi session)
    {
        Uwf = uwf;
        Installer = installer;
        Detection = detection;
        Session = session;
        // Each context gets its own private in-memory store.
        Store = new LocalStore($"file:{Guid.NewGuid():n}?mode=memory&cache=shared");
    }

    public Task ReportProgressAsync(string commandId, InstallState state, int percent, string detail)
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

    public void Dispose() => Store.Dispose();
}

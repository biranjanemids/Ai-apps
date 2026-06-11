using Ltsc.Agent;
using Ltsc.Agent.Comm;
using Ltsc.Agent.Modules;
using Ltsc.Agent.Platform;
using Ltsc.Agent.Storage;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

var builder = Host.CreateApplicationBuilder(args);

// Bind options from config / env (Ltsc__ServerAddress, Ltsc__EnrollmentToken, ...).
var options = new AgentOptions();
builder.Configuration.GetSection("Ltsc").Bind(options);
builder.Services.AddSingleton(options);

// Register as a Windows Service when running on Windows; no-op elsewhere.
builder.Services.AddWindowsService(o => o.ServiceName = "LtscAgent");

// Local store on a (production: UWF-excluded) path.
builder.Services.AddSingleton(_ => new LocalStore(options.LocalStorePath));

// App-side platform abstractions — stubs cross-platform.
builder.Services.AddSingleton<IInstallerRunner, StubInstallerRunner>();
builder.Services.AddSingleton<IDetectionProbe, StubDetectionProbe>();
builder.Services.AddSingleton<ISessionUi, StubSessionUi>();

// Write filter + config setting appliers: real Windows implementations when
// running on Windows (net8.0-windows build), cross-platform stubs otherwise so
// the agent builds, tests, and demos on Linux/CI (design §A4).
#if WINDOWS
if (OperatingSystem.IsWindows())
{
    Ltsc.Agent.Platform.Windows.WindowsPlatform.Register(builder.Services);
}
else
#endif
{
    builder.Services.AddSingleton<IWriteFilterGuard, StubWriteFilterGuard>();
    AddStubAppliers(builder.Services);
}

// Capability modules.
builder.Services.AddSingleton<IManagementModule, AppModule>();
builder.Services.AddSingleton<IManagementModule, ConfigModule>();

// Comm + orchestrator. CommChannel is also the artifact fetcher (verified
// downloads over the same mTLS channel).
builder.Services.AddSingleton(sp => new CommChannel(
    options.ServerAddress,
    sp.GetRequiredService<LocalStore>(),
    sp.GetRequiredService<ILogger<CommChannel>>()));
builder.Services.AddSingleton<IArtifactFetcher>(sp => sp.GetRequiredService<CommChannel>());
builder.Services.AddSingleton<Orchestrator>();

builder.Services.AddHostedService<AgentService>();

builder.Build().Run();

// Registers one cross-platform stub applier per config profile kind. Persistent
// kinds (registry/uwf/kiosk) are UWF-bracketed by the reconcile loop.
static void AddStubAppliers(IServiceCollection services)
{
    void Add(ConfigProfile.BodyOneofCase kind, bool persist) =>
        services.AddSingleton<ISettingApplier>(sp =>
            new StubSettingApplier(kind, persist, sp.GetService<ILogger<StubSettingApplier>>()));

    Add(ConfigProfile.BodyOneofCase.Registry, persist: true);
    Add(ConfigProfile.BodyOneofCase.Uwf, persist: true);
    Add(ConfigProfile.BodyOneofCase.Kiosk, persist: true);
    Add(ConfigProfile.BodyOneofCase.Network, persist: false);
    Add(ConfigProfile.BodyOneofCase.Power, persist: false);
    Add(ConfigProfile.BodyOneofCase.Time, persist: false);
    Add(ConfigProfile.BodyOneofCase.Certs, persist: false);
    Add(ConfigProfile.BodyOneofCase.Applocker, persist: false);
    Add(ConfigProfile.BodyOneofCase.Keyfilter, persist: false);
}

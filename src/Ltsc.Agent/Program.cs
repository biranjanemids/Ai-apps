using Ltsc.Agent;
using Ltsc.Agent.Comm;
using Ltsc.Agent.Modules;
using Ltsc.Agent.Platform;
using Ltsc.Agent.Storage;
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

// Platform abstractions — stubs here; swap for Windows implementations in prod.
builder.Services.AddSingleton<IWriteFilterGuard, StubWriteFilterGuard>();
builder.Services.AddSingleton<IInstallerRunner, StubInstallerRunner>();
builder.Services.AddSingleton<IDetectionProbe, StubDetectionProbe>();
builder.Services.AddSingleton<ISessionUi, StubSessionUi>();

// Capability modules.
builder.Services.AddSingleton<IManagementModule, AppModule>();

// Comm + orchestrator.
builder.Services.AddSingleton(sp => new CommChannel(
    options.ServerAddress,
    sp.GetRequiredService<LocalStore>(),
    sp.GetRequiredService<ILogger<CommChannel>>()));
builder.Services.AddSingleton<Orchestrator>();

builder.Services.AddHostedService<AgentService>();

builder.Build().Run();

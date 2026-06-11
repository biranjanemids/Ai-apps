using Ltsc.Server.Ca;
using Ltsc.Server.Registry;
using Ltsc.Server.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddGrpc();

// Singletons make up the in-process control plane. In production these are
// separate services backed by PostgreSQL / Redis / NATS (design §12).
builder.Services.AddSingleton<DeviceRegistry>();
builder.Services.AddSingleton<ConnectionRegistry>();
builder.Services.AddSingleton<DevCertAuthority>();
builder.Services.AddSingleton<DemoCommandPusher>();
builder.Services.AddSingleton<PolicyRegistry>();

// Listen on HTTP/2 cleartext for local demo. Production terminates mTLS here
// (TLS 1.3, client device certificate) — see design §13.
builder.WebHost.ConfigureKestrel(o =>
{
    o.ListenAnyIP(8080, lo => lo.Protocols = Microsoft.AspNetCore.Server.Kestrel.Core.HttpProtocols.Http2);
});

var app = builder.Build();

app.MapGrpcService<EnrollmentService>();
app.MapGrpcService<DeviceLinkService>();
app.MapGrpcService<TransferService>();
app.MapGrpcService<PolicyService>();
app.MapGet("/", () => "Ltsc MgmtServer — gRPC on h2c :8080 (Enrollment, DeviceLink, Transfer, Policy)");

app.Run();

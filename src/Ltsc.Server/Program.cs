using Ltsc.Server.Ca;
using Ltsc.Server.Registry;
using Ltsc.Server.Services;
using Microsoft.AspNetCore.Server.Kestrel.Https;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddGrpc();

var stateDir = builder.Configuration["Ltsc:StateDir"] ?? "server-state";
var ca = new CertAuthority(stateDir);

// Control-plane services. SQLite-durable on a single node; the design (§12)
// swaps storage for PostgreSQL/Redis/NATS for multi-node scale.
builder.Services.AddSingleton(ca);
builder.Services.AddSingleton(new ServerStore(Path.Combine(stateDir, "server.db")));
builder.Services.AddSingleton(sp => new DeviceRegistry(sp.GetRequiredService<ServerStore>()));
builder.Services.AddSingleton<ConnectionRegistry>();
builder.Services.AddSingleton<PolicyRegistry>();
builder.Services.AddSingleton<ArtifactStore>();
builder.Services.AddSingleton<DemoCommandPusher>();

// TLS 1.2+ with the CA-issued server certificate. Client certificates are
// requested and validated against the internal CA; Enrollment is the only
// service that accepts a connection without one (design §6, §13).
builder.WebHost.ConfigureKestrel(o =>
{
    o.ListenAnyIP(8443, lo =>
    {
        lo.Protocols = Microsoft.AspNetCore.Server.Kestrel.Core.HttpProtocols.Http2;
        lo.UseHttps(https =>
        {
            https.ServerCertificate = ca.ServerCertificate;
            https.ClientCertificateMode = ClientCertificateMode.AllowCertificate;
            // Chain validation against the internal CA happens here at the TLS
            // layer; per-service enforcement (DeviceAuth) rejects absent certs.
            https.ClientCertificateValidation = (cert, _, _) => ca.ValidateDeviceCertificate(cert);
        });
    });
});

var app = builder.Build();

app.MapGrpcService<EnrollmentService>();
app.MapGrpcService<DeviceLinkService>();
app.MapGrpcService<TransferService>();
app.MapGrpcService<PolicyService>();

// ---- Minimal admin console (read-only; design §12 grows this into the BFF/SPA) ----
app.MapGet("/api/devices", (DeviceRegistry devices, ConnectionRegistry connections, PolicyRegistry policies) =>
    Results.Json(devices.All().Select(d => new
    {
        d.DeviceId,
        d.GroupId,
        Model = d.Facts?.Model,
        Os = d.Facts?.OsBuild,
        d.PolicyVersion,
        ExpectedPolicy = policies.ForGroup(d.GroupId).ContentHash,
        InPolicy = d.PolicyVersion == policies.ForGroup(d.GroupId).ContentHash,
        Online = connections.IsOnline(d.DeviceId),
        LastSeen = d.LastSeen,
        d.RebootPending,
    })));

app.MapGet("/console", () => Results.Content("""
<!doctype html><meta charset="utf-8"><title>LTSC Fleet</title>
<style>body{font-family:system-ui;margin:2rem}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}th{background:#f5f5f5}
.on{color:#0a0}.off{color:#a00}.ok{color:#0a0}.drift{color:#c60}</style>
<h1>LTSC Fleet</h1><table id="t"><tr><th>Device</th><th>Group</th><th>Model</th>
<th>Online</th><th>Policy</th><th>Reboot pending</th><th>Last seen</th></tr></table>
<script>
async function load(){const r=await fetch('/api/devices');const ds=await r.json();
const t=document.getElementById('t');t.querySelectorAll('tr:not(:first-child)').forEach(e=>e.remove());
for(const d of ds){const tr=t.insertRow();tr.innerHTML=
`<td>${d.deviceId}</td><td>${d.groupId}</td><td>${d.model??''}</td>`+
`<td class="${d.online?'on':'off'}">${d.online?'online':'offline'}</td>`+
`<td class="${d.inPolicy?'ok':'drift'}">${d.inPolicy?'in policy':'drift'}</td>`+
`<td>${d.rebootPending?'yes':'no'}</td><td>${d.lastSeen}</td>`;}}
load();setInterval(load,5000);
</script>
""", "text/html"));

app.MapGet("/", () => "Ltsc MgmtServer — gRPC/mTLS on :8443 (Enrollment, DeviceLink, Transfer, Policy) · console at /console");

app.Run();

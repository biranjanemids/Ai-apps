using Google.Protobuf;
using Ltsc.Mgmt.V1;
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
builder.Services.AddSingleton<InventoryStore>();
builder.Services.AddSingleton<ImageRegistry>();
builder.Services.AddSingleton<DemoCommandPusher>();
builder.Services.AddSingleton<CommandDispatcher>();
builder.Services.AddSingleton<AdminAuth>();
builder.Services.AddSingleton<ShadowStore>();

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
app.MapGrpcService<Ltsc.Server.Services.PolicyService>();
app.MapGrpcService<ShadowService>();

// ---- Minimal admin console (read-only; design §12 grows this into the BFF/SPA) ----
app.MapGet("/api/devices", (DeviceRegistry devices, ConnectionRegistry connections, PolicyRegistry policies, AdminAuth auth, HttpContext http) =>
    auth.Require(http, Role.Viewer) is null ? Results.Unauthorized() :
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

app.MapGet("/api/devices/{id}/inventory", (string id, InventoryStore inv, AdminAuth auth, HttpContext http) =>
    auth.Require(http, Role.Viewer) is null ? Results.Unauthorized()
        : inv.GetInventory(id) is { } r ? Results.Json(r) : Results.NotFound());

app.MapGet("/api/devices/{id}/commands", (string id, InventoryStore inv, AdminAuth auth, HttpContext http) =>
    auth.Require(http, Role.Viewer) is null ? Results.Unauthorized()
        : Results.Json(inv.GetResults(id).Select(r => new { r.CommandId, r.Status, r.ExitCode, r.StdoutTail })));

// Issue a remote command from the console (Operator+). Signed + pushed + audited.
app.MapPost("/api/devices/{id}/command", (string id, string action, string? services,
    DeviceRegistry devices, ImageRegistry images, CommandDispatcher d, AdminAuth auth, ServerStore store, HttpContext http) =>
{
    var actor = auth.Require(http, Role.Operator);
    if (actor is null) return Results.StatusCode(auth.Resolve(http).role == Role.None ? 401 : 403);

    var model = devices.TryGet(id, out var dev) ? dev.Facts?.Model ?? "" : "";
    var (capability, act, spec) = action switch
    {
        "collect" => ("inventory", "collect", ByteString.Empty),
        "restart_services" => ("command", "restart_services",
            new RestartServicesSpec { Services = { (services ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries) } }.ToByteString()),
        "update_scan" => ("update", "scan", new UpdateSpec { IncludeFeatureUpdates = true }.ToByteString()),
        "update_install" => ("update", "install",
            new UpdateSpec { Ring = "broad", Reboot = new RebootPolicy { Required = true, AllowDefer = true, MaxTotalSeconds = 86400 } }.ToByteString()),
        "capture" => ("image", "capture", new CaptureSpec { Format = "ffu", TargetDrive = "0", ImageId = "capture", Model = model }.ToByteString()),
        "trigger_bmr" => ("image", "trigger_bmr", images.ForModel(model).ToByteString()),
        "shadow" => ("shadow", "start", ByteString.Empty),
        _ => ("command", action, ByteString.Empty),
    };
    var (sent, commandId) = d.Dispatch(id, capability, act, spec);
    store.AddAudit(actor, $"command:{action}", id, sent ? $"dispatched {commandId}" : "device offline");
    return sent ? Results.Ok(new { commandId, action }) : Results.Conflict(new { error = "device offline" });
});

// ---- Authored policy (Admin authors; Viewer reads) ----
app.MapGet("/api/groups/{group}/policy", (string group, PolicyRegistry policies, AdminAuth auth, HttpContext http) =>
    auth.Require(http, Role.Viewer) is null ? Results.Unauthorized()
        : Results.Text(Google.Protobuf.JsonFormatter.Default.Format(policies.ForGroup(group)), "application/json"));

app.MapPost("/api/groups/{group}/policy", async (string group, PolicyRegistry policies, DeviceRegistry devices,
    ConnectionRegistry connections, AdminAuth auth, ServerStore store, HttpContext http) =>
{
    var actor = auth.Require(http, Role.Admin);
    if (actor is null) return Results.StatusCode(auth.Resolve(http).role == Role.None ? 401 : 403);

    using var reader = new StreamReader(http.Request.Body);
    var body = await reader.ReadToEndAsync();
    PolicySnapshot parsed;
    try { parsed = Google.Protobuf.JsonParser.Default.Parse<PolicySnapshot>(body); }
    catch (Exception ex) { return Results.BadRequest(new { error = $"invalid policy JSON: {ex.Message}" }); }

    var snap = policies.SetGroupPolicy(group, parsed);
    store.AddAudit(actor, "policy:set", group, $"version {snap.Version} hash {snap.ContentHash} ({snap.Profiles.Count} profiles)");

    // Push SyncPolicy to online devices in the group so they re-reconcile (design §7).
    var nudged = 0;
    foreach (var dev in devices.All().Where(x => x.GroupId == group && connections.IsOnline(x.DeviceId)))
    {
        connections.Send(dev.DeviceId, new ServerMessage { Sync = new SyncPolicy { ExpectedPolicyVersion = snap.ContentHash } });
        nudged++;
    }
    return Results.Ok(new { snap.Version, snap.ContentHash, profiles = snap.Profiles.Count, nudged });
});

app.MapGet("/api/audit", (ServerStore store, AdminAuth auth, HttpContext http) =>
    auth.Require(http, Role.Admin) is null ? Results.Unauthorized()
        : Results.Json(store.LoadAudit().Select(a => new { a.Ts, a.Actor, a.Action, a.Target, a.Detail })));

app.MapGet("/api/devices/{id}/shadow", (string id, ShadowStore shadow, AdminAuth auth, HttpContext http) =>
    auth.Require(http, Role.Viewer) is null ? Results.Unauthorized()
        : shadow.Get(id) is { } s ? Results.Json(new { s.SessionId, s.Width, s.Height, s.Mime, s.LastSeq, s.Frames, s.StartedUtc, s.Active })
        : Results.NotFound());

app.MapGet("/console", () => Results.Content("""
<!doctype html><meta charset="utf-8"><title>LTSC Fleet</title>
<style>body{font-family:system-ui;margin:2rem}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}th{background:#f5f5f5}
.on{color:#0a0}.off{color:#a00}.ok{color:#0a0}.drift{color:#c60}
input,button{padding:.3rem}</style>
<h1>LTSC Fleet</h1>
<p>API token: <input id="tok" value="viewer-token" size="20">
(viewer-token / operator-token / admin-token)
<button onclick="cmd('reboot')">Reboot</button>
<button onclick="cmd('collect')">Collect inventory</button>
<button onclick="cmd('update_install')">Update</button>
<button onclick="cmd('trigger_bmr')">BMR</button> (acts on selected row)</p>
<table id="t"><tr><th>Sel</th><th>Device</th><th>Group</th><th>Model</th>
<th>Online</th><th>Policy</th><th>Reboot pending</th><th>Last seen</th></tr></table>
<script>
let sel=null;
function hdr(){return {'Authorization':'Bearer '+document.getElementById('tok').value};}
async function load(){const r=await fetch('/api/devices',{headers:hdr()});if(!r.ok)return;const ds=await r.json();
const t=document.getElementById('t');t.querySelectorAll('tr:not(:first-child)').forEach(e=>e.remove());
for(const d of ds){const tr=t.insertRow();tr.innerHTML=
`<td><input type=radio name=sel ${d.deviceId===sel?'checked':''} onclick="sel='${d.deviceId}'"></td>`+
`<td>${d.deviceId}</td><td>${d.groupId}</td><td>${d.model??''}</td>`+
`<td class="${d.online?'on':'off'}">${d.online?'online':'offline'}</td>`+
`<td class="${d.inPolicy?'ok':'drift'}">${d.inPolicy?'in policy':'drift'}</td>`+
`<td>${d.rebootPending?'yes':'no'}</td><td>${d.lastSeen}</td>`;}}
async function cmd(a){if(!sel){alert('select a device');return;}
const r=await fetch(`/api/devices/${sel}/command?action=${a}`,{method:'POST',headers:hdr()});
alert(a+': '+r.status+' '+await r.text());}
load();setInterval(load,5000);
</script>
""", "text/html"));

app.MapGet("/", () => "Ltsc MgmtServer — gRPC/mTLS on :8443 (Enrollment, DeviceLink, Transfer, Policy) · console at /console");

app.Run();

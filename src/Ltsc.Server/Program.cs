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

builder.Services.AddSingleton(ca);

// Durable state: PostgreSQL when Ltsc:Postgres is set (multi-node shared state),
// else SQLite (single-node). Same IServerStore contract either way (design §12.3).
var pg = builder.Configuration["Ltsc:Postgres"];
if (!string.IsNullOrWhiteSpace(pg))
    builder.Services.AddSingleton<IServerStore>(new PostgresServerStore(pg));
else
    builder.Services.AddSingleton<IServerStore>(new SqliteServerStore(Path.Combine(stateDir, "server.db")));

builder.Services.AddSingleton(sp => new DeviceRegistry(sp.GetRequiredService<IServerStore>()));
builder.Services.AddSingleton<ConnectionRegistry>();

// Presence + cross-node command routing: Redis when Ltsc:Redis is set (any node
// can reach any device), else in-process. NATS is an interchangeable bus (§12.2).
var redis = builder.Configuration["Ltsc:Redis"];
if (!string.IsNullOrWhiteSpace(redis))
    builder.Services.AddSingleton<IPresence>(sp => new RedisPresence(redis, sp.GetRequiredService<ConnectionRegistry>()));
else
    builder.Services.AddSingleton<IPresence, InProcessPresence>();
builder.Services.AddSingleton<DeviceRouter>();

builder.Services.AddSingleton<PolicyRegistry>();
builder.Services.AddSingleton<ArtifactStore>();
builder.Services.AddSingleton<InventoryStore>();
builder.Services.AddSingleton<ImageRegistry>();
builder.Services.AddSingleton<DemoCommandPusher>();
builder.Services.AddSingleton<CommandDispatcher>();
builder.Services.AddSingleton<AdminAuth>();
builder.Services.AddSingleton<ShadowStore>();
builder.Services.AddSingleton<AgentRelease>();

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

// ---- Admin API (tenant-scoped; RBAC via AdminAuth) ----
app.MapGet("/api/devices", (DeviceRegistry devices, DeviceRouter router, PolicyRegistry policies, AdminAuth auth, HttpContext http) =>
{
    var who = auth.Require(http, Role.Viewer);
    if (who is null) return Results.Unauthorized();
    var tenant = who.Value.tenant;
    return Results.Json(devices.ForTenant(tenant).Select(d => new
    {
        d.DeviceId,
        d.TenantId,
        d.GroupId,
        Model = d.Facts?.Model,
        Os = d.Facts?.OsBuild,
        d.PolicyVersion,
        ExpectedPolicy = policies.ForGroup(d.TenantId, d.GroupId).ContentHash,
        InPolicy = d.PolicyVersion == policies.ForGroup(d.TenantId, d.GroupId).ContentHash,
        Online = router.IsOnline(d.DeviceId),
        LastSeen = d.LastSeen,
        d.RebootPending,
    }));
});

// True if the caller may act on this device (same tenant). 404 hides cross-tenant ids.
static bool InTenant(DeviceRegistry devices, string id, string tenant) =>
    devices.TryGet(id, out var d) && d.TenantId == tenant;

app.MapGet("/api/devices/{id}/inventory", (string id, DeviceRegistry devices, InventoryStore inv, AdminAuth auth, HttpContext http) =>
{
    var who = auth.Require(http, Role.Viewer);
    if (who is null) return Results.Unauthorized();
    if (!InTenant(devices, id, who.Value.tenant)) return Results.NotFound();
    return inv.GetInventory(id) is { } r ? Results.Json(r) : Results.NotFound();
});

app.MapGet("/api/devices/{id}/commands", (string id, DeviceRegistry devices, InventoryStore inv, AdminAuth auth, HttpContext http) =>
{
    var who = auth.Require(http, Role.Viewer);
    if (who is null) return Results.Unauthorized();
    if (!InTenant(devices, id, who.Value.tenant)) return Results.NotFound();
    return Results.Json(inv.GetResults(id).Select(r => new { r.CommandId, r.Status, r.ExitCode, r.StdoutTail }));
});

// Issue a remote command from the console (Operator+). Signed + pushed + audited.
app.MapPost("/api/devices/{id}/command", (string id, string action, string? services,
    DeviceRegistry devices, ImageRegistry images, CommandDispatcher d, AdminAuth auth, IServerStore store, HttpContext http) =>
{
    var who = auth.Require(http, Role.Operator);
    if (who is null) return Results.StatusCode(auth.Resolve(http).role == Role.None ? 401 : 403);
    var (actor, tenant) = who.Value;
    if (!InTenant(devices, id, tenant)) return Results.NotFound();

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
    store.AddAudit(tenant, actor, $"command:{action}", id, sent ? $"dispatched {commandId}" : "device offline");
    return sent ? Results.Ok(new { commandId, action }) : Results.Conflict(new { error = "device offline" });
});

// ---- Authored policy (Admin authors; Viewer reads). Tenant-scoped. ----
app.MapGet("/api/groups/{group}/policy", (string group, PolicyRegistry policies, AdminAuth auth, HttpContext http) =>
{
    var who = auth.Require(http, Role.Viewer);
    if (who is null) return Results.Unauthorized();
    return Results.Text(Google.Protobuf.JsonFormatter.Default.Format(policies.ForGroup(who.Value.tenant, group)), "application/json");
});

app.MapPost("/api/groups/{group}/policy", async (string group, PolicyRegistry policies, DeviceRegistry devices,
    DeviceRouter router, AdminAuth auth, IServerStore store, HttpContext http) =>
{
    var who = auth.Require(http, Role.Admin);
    if (who is null) return Results.StatusCode(auth.Resolve(http).role == Role.None ? 401 : 403);
    var (actor, tenant) = who.Value;

    using var reader = new StreamReader(http.Request.Body);
    var body = await reader.ReadToEndAsync();
    PolicySnapshot parsed;
    try { parsed = Google.Protobuf.JsonParser.Default.Parse<PolicySnapshot>(body); }
    catch (Exception ex) { return Results.BadRequest(new { error = $"invalid policy JSON: {ex.Message}" }); }

    var snap = policies.SetGroupPolicy(tenant, group, parsed);
    store.AddAudit(tenant, actor, "policy:set", group, $"version {snap.Version} hash {snap.ContentHash} ({snap.Profiles.Count} profiles)");

    // Push SyncPolicy to online devices in this tenant+group so they re-reconcile (§7).
    var nudged = 0;
    foreach (var dev in devices.ForTenant(tenant).Where(x => x.GroupId == group && router.IsOnline(x.DeviceId)))
    {
        router.Send(dev.DeviceId, new ServerMessage { Sync = new SyncPolicy { ExpectedPolicyVersion = snap.ContentHash } });
        nudged++;
    }
    return Results.Ok(new { snap.Version, snap.ContentHash, profiles = snap.Profiles.Count, nudged });
});

app.MapGet("/api/audit", (IServerStore store, AdminAuth auth, HttpContext http) =>
{
    var who = auth.Require(http, Role.Admin);
    if (who is null) return Results.Unauthorized();
    return Results.Json(store.LoadAudit(who.Value.tenant).Select(a => new { a.Ts, a.Actor, a.Action, a.Target, a.Detail }));
});

app.MapGet("/api/devices/{id}/shadow", (string id, DeviceRegistry devices, ShadowStore shadow, AdminAuth auth, HttpContext http) =>
{
    var who = auth.Require(http, Role.Viewer);
    if (who is null) return Results.Unauthorized();
    if (!InTenant(devices, id, who.Value.tenant)) return Results.NotFound();
    return shadow.Get(id) is { } s ? Results.Json(new { s.SessionId, s.Width, s.Height, s.Mime, s.LastSeq, s.Frames, s.StartedUtc, s.Active }) : Results.NotFound();
});

// Lets the SPA show the caller's role/tenant and gate actions accordingly.
app.MapGet("/api/whoami", (AdminAuth auth, HttpContext http) =>
{
    var (actor, role, tenant) = auth.Resolve(http);
    return Results.Json(new { actor, role = role.ToString(), tenant });
});

app.MapGet("/console", () => Results.Content(Ltsc.Server.ConsoleHtml.Page, "text/html"));

app.MapGet("/", () => "Ltsc MgmtServer — gRPC/mTLS on :8443 (Enrollment, DeviceLink, Transfer, Policy, Shadow) · console at /console");

app.Run();

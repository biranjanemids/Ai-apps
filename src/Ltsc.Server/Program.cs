using Google.Protobuf;
using Ltsc.Mgmt.V1;
using Ltsc.Server.Ca;
using Ltsc.Server.Registry;
using Ltsc.Server.Services;
using Microsoft.AspNetCore.Server.Kestrel.Https;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddGrpc();

var stateDir = builder.Configuration["Ltsc:StateDir"] ?? "server-state";

// Durable state: PostgreSQL when Ltsc:Postgres is set (multi-node shared state),
// else SQLite (single-node). Same IServerStore contract either way (design §12.3).
var pg = builder.Configuration["Ltsc:Postgres"];
IServerStore store = string.IsNullOrWhiteSpace(pg)
    ? new SqliteServerStore(Path.Combine(stateDir, "server.db"))
    : new PostgresServerStore(pg);

// CA shares the store so the certificate revocation list survives restarts (§13).
var ca = new CertAuthority(stateDir, store);

builder.Services.AddSingleton(store);
builder.Services.AddSingleton(ca);
builder.Services.AddSingleton(new DeviceRegistry(store));
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
builder.Services.AddSingleton<AlertStore>();
builder.Services.AddSingleton<AppCatalog>();
builder.Services.AddSingleton<IIntentTranslator, RuleIntentTranslator>();

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

// Revoke a device's certificate (Admin, tenant-scoped). The device is locked out
// on its next mTLS call; revocation persists in the CRL (design §13).
app.MapPost("/api/devices/{id}/revoke", (string id, DeviceRegistry devices, CertAuthority ca,
    AdminAuth auth, IServerStore store, AlertStore alerts, HttpContext http) =>
{
    var who = auth.Require(http, Role.Admin);
    if (who is null) return Results.StatusCode(auth.Resolve(http).role == Role.None ? 401 : 403);
    var (actor, tenant) = who.Value;
    if (!devices.TryGet(id, out var dev) || dev.TenantId != tenant) return Results.NotFound();
    if (string.IsNullOrEmpty(dev.CertThumbprint)) return Results.BadRequest(new { error = "no certificate on record" });

    ca.Revoke(dev.CertThumbprint);
    store.AddAudit(tenant, actor, "device:revoke", id, $"cert {dev.CertThumbprint}");
    alerts.Add(new Alert(tenant, id, "warn", "device.revoked", $"certificate {dev.CertThumbprint} revoked by {actor}", DateTimeOffset.UtcNow));
    return Results.Ok(new { id, revoked = dev.CertThumbprint });
});

// USB imaging media manifest (design §11.2): describes the offline payload an
// operator materializes with deploy/packaging/build-usb-media.sh (image + seed).
app.MapPost("/api/images/{imageId}/usb", (string imageId, string? group, ImageRegistry images,
    ArtifactStore artifacts, AdminAuth auth, IServerStore store, HttpContext http) =>
{
    var who = auth.Require(http, Role.Admin);
    if (who is null) return Results.StatusCode(auth.Resolve(http).role == Role.None ? 401 : 403);
    var (actor, tenant) = who.Value;
    var sha = Convert.ToHexString(artifacts.GetSha256(imageId));
    store.AddAudit(tenant, actor, "image:usb_media", imageId, $"group {group ?? "group-default"}");
    return Results.Json(new
    {
        imageId,
        sha256 = sha,
        format = "ffu",
        group = group ?? "group-default",
        seedHint = new { enrollmentToken = "<group-token>", note = "agent auto-enrolls on first boot" },
        build = $"deploy/packaging/build-usb-media.sh {imageId} https://<server>:8443 <token> {group ?? "group-default"}",
    });
});

// ---- App catalog: register packages + assign to groups (design §8/§12) ----
app.MapGet("/api/apps", (AppCatalog catalog, AdminAuth auth, HttpContext http) =>
{
    var who = auth.Require(http, Role.Viewer);
    if (who is null) return Results.Unauthorized();
    return Results.Json(catalog.ForTenant(who.Value.tenant)
        .Select(p => new { p.AppId, p.Version, installer = p.Spec.Installer?.Type }));
});

// Register/update an app package. Body = InstallSpec as protobuf-JSON.
app.MapPost("/api/apps", async (AppCatalog catalog, AdminAuth auth, IServerStore store, HttpContext http) =>
{
    var who = auth.Require(http, Role.Admin);
    if (who is null) return Results.StatusCode(auth.Resolve(http).role == Role.None ? 401 : 403);
    var (actor, tenant) = who.Value;

    using var reader = new StreamReader(http.Request.Body);
    InstallSpec spec;
    try { spec = Google.Protobuf.JsonParser.Default.Parse<InstallSpec>(await reader.ReadToEndAsync()); }
    catch (Exception ex) { return Results.BadRequest(new { error = $"invalid InstallSpec JSON: {ex.Message}" }); }
    if (string.IsNullOrEmpty(spec.AppId)) return Results.BadRequest(new { error = "app_id required" });

    catalog.Register(tenant, spec.AppId, spec.Version, spec);
    store.AddAudit(tenant, actor, "app:register", spec.AppId, $"version {spec.Version}");
    return Results.Ok(new { spec.AppId, spec.Version });
});

// Assign an app to a group: install on online devices now + on connect for the rest.
app.MapPost("/api/groups/{group}/apps/{appId}", (string group, string appId, AppCatalog catalog,
    DeviceRegistry devices, DeviceRouter router, CommandDispatcher d, AdminAuth auth, IServerStore store, HttpContext http) =>
{
    var who = auth.Require(http, Role.Admin);
    if (who is null) return Results.StatusCode(auth.Resolve(http).role == Role.None ? 401 : 403);
    var (actor, tenant) = who.Value;
    if (!catalog.TryGet(tenant, appId, out var pkg)) return Results.NotFound(new { error = "unknown app" });

    catalog.Assign(tenant, group, appId);
    store.AddAudit(tenant, actor, "app:assign", $"{group}/{appId}", $"version {pkg.Version}");

    var dispatched = 0;
    foreach (var dev in devices.ForTenant(tenant).Where(x => x.GroupId == group && router.IsOnline(x.DeviceId)))
    {
        d.Dispatch(dev.DeviceId, "app", "install", pkg.Spec.ToByteString());
        dispatched++;
    }
    return Results.Ok(new { appId, group, dispatched });
});

// ---- Zero-trust posture (Viewer, tenant-scoped) ----
app.MapGet("/api/devices/{id}/posture", (string id, DeviceRegistry devices, AdminAuth auth, HttpContext http) =>
{
    var who = auth.Require(http, Role.Viewer);
    if (who is null) return Results.Unauthorized();
    if (!devices.TryGet(id, out var d) || d.TenantId != who.Value.tenant) return Results.NotFound();
    return Results.Json(new { id, compliant = !d.Quarantined, quarantined = d.Quarantined, violations = d.PostureViolations });
});

// ---- Carbon-aware scheduling window ----
app.MapGet("/api/carbon", (AdminAuth auth, HttpContext http) =>
{
    if (auth.Require(http, Role.Viewer) is null) return Results.Unauthorized();
    var now = DateTimeOffset.Now;
    return Results.Json(new
    {
        green = CarbonScheduler.IsGreen(now),
        intensity = CarbonScheduler.IntensityProxy(now),
        nextGreen = CarbonScheduler.NextGreen(now),
    });
});

// ---- Digital-twin: simulate a proposed policy before applying (Admin) ----
app.MapPost("/api/groups/{group}/policy/simulate", async (string group, PolicyRegistry policies, DeviceRegistry devices,
    AdminAuth auth, HttpContext http) =>
{
    var who = auth.Require(http, Role.Admin);
    if (who is null) return Results.StatusCode(auth.Resolve(http).role == Role.None ? 401 : 403);
    var (actor, tenant) = who.Value;

    using var reader = new StreamReader(http.Request.Body);
    PolicySnapshot proposed;
    try { proposed = Google.Protobuf.JsonParser.Default.Parse<PolicySnapshot>(await reader.ReadToEndAsync()); }
    catch (Exception ex) { return Results.BadRequest(new { error = $"invalid policy JSON: {ex.Message}" }); }

    var current = policies.ForGroup(tenant, group);
    var devCount = devices.ForTenant(tenant).Count(d => d.GroupId == group);
    var impact = PolicySimulator.Simulate(current, proposed, devCount);
    return Results.Json(impact);
});

// ---- AI ops copilot: natural language -> typed fleet action plan ----
app.MapPost("/api/ops/ask", (string? dryRun, bool? whenGreen, DeviceRegistry devices, DeviceRouter router,
    InventoryStore inv, PolicyRegistry policies, IIntentTranslator translator, CommandDispatcher dispatch,
    ImageRegistry images, AdminAuth auth, IServerStore store, HttpContext http, OpsAsk body) =>
{
    var who = auth.Require(http, Role.Operator);
    if (who is null) return Results.StatusCode(auth.Resolve(http).role == Role.None ? 401 : 403);
    var (actor, tenant) = who.Value;

    var intent = translator.Translate(body?.Q ?? "");
    if (intent is null) return Results.BadRequest(new { error = "could not understand request" });

    // Resolve the target set from the intent filter (health/online/group/drift).
    var matched = devices.ForTenant(tenant).Where(d =>
    {
        if (intent.Filter.Group is { } g && d.GroupId != g) return false;
        if (intent.Filter.Online is { } on && router.IsOnline(d.DeviceId) != on) return false;
        if (intent.Filter.Drift is { } dr)
        {
            var drifted = d.PolicyVersion != policies.ForGroup(d.TenantId, d.GroupId).ContentHash;
            if (drifted != dr) return false;
        }
        if (intent.Filter.Band is { } band)
        {
            var fails = inv.GetResults(d.DeviceId).Count(r => r.Status is "Failed" or "RolledBack");
            var hs = FleetHealth.Score(router.IsOnline(d.DeviceId), d.LastSeen, inv.GetHealth(d.DeviceId), inv.GetInventory(d.DeviceId), fails);
            if (hs.Band != band) return false;
        }
        return true;
    }).Select(d => d.DeviceId).ToList();

    var isDryRun = dryRun != "false";              // safe default: plan only
    var defer = whenGreen == true && !CarbonScheduler.IsGreen(DateTimeOffset.Now);

    var dispatched = 0;
    if (!isDryRun && !defer)
        foreach (var id in matched)
        { dispatch.Dispatch(id, intent.Capability, intent.Action, Google.Protobuf.ByteString.Empty); dispatched++; }

    if (!isDryRun)
        store.AddAudit(tenant, actor, "ops:ask", intent.Summary, $"matched {matched.Count}, dispatched {dispatched}, deferred={defer}");

    return Results.Json(new
    {
        intent.Summary,
        intent.Capability,
        intent.Action,
        matched,
        dryRun = isDryRun,
        dispatched,
        deferredToGreenWindow = defer ? CarbonScheduler.NextGreen(DateTimeOffset.Now) : (DateTimeOffset?)null,
    });
});

// ---- Predictive fleet health (futuristic: get ahead of failures) ----
static FleetHealth.Result DeviceHealth(DeviceRegistry.DeviceRecord d, DeviceRouter router, InventoryStore inv) =>
    FleetHealth.Score(
        online: router.IsOnline(d.DeviceId),
        lastSeen: d.LastSeen,
        health: inv.GetHealth(d.DeviceId),
        inv: inv.GetInventory(d.DeviceId),
        recentFailures: inv.GetResults(d.DeviceId).Count(r => r.Status is "Failed" or "RolledBack"));

app.MapGet("/api/devices/{id}/health", (string id, DeviceRegistry devices, DeviceRouter router, InventoryStore inv, AdminAuth auth, HttpContext http) =>
{
    var who = auth.Require(http, Role.Viewer);
    if (who is null) return Results.Unauthorized();
    if (!devices.TryGet(id, out var d) || d.TenantId != who.Value.tenant) return Results.NotFound();
    var h = DeviceHealth(d, router, inv);
    return Results.Json(new { id, h.Score, h.Band, h.Risks });
});

app.MapGet("/api/health", (DeviceRegistry devices, DeviceRouter router, InventoryStore inv, AdminAuth auth, HttpContext http) =>
{
    var who = auth.Require(http, Role.Viewer);
    if (who is null) return Results.Unauthorized();
    var scored = devices.ForTenant(who.Value.tenant).Select(d => DeviceHealth(d, router, inv)).ToList();
    return Results.Json(new
    {
        total = scored.Count,
        healthy = scored.Count(s => s.Band == "healthy"),
        warning = scored.Count(s => s.Band == "warning"),
        critical = scored.Count(s => s.Band == "critical"),
        avgScore = scored.Count == 0 ? 100 : (int)scored.Average(s => s.Score),
    });
});

// Alert feed (Viewer, tenant-scoped).
app.MapGet("/api/alerts", (AlertStore alerts, AdminAuth auth, HttpContext http) =>
{
    var who = auth.Require(http, Role.Viewer);
    if (who is null) return Results.Unauthorized();
    return Results.Json(alerts.ForTenant(who.Value.tenant)
        .Select(a => new { a.Ts, a.DeviceId, a.Severity, a.Type, a.Detail }));
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

// Request body for the AI ops copilot endpoint.
record OpsAsk(string? Q);

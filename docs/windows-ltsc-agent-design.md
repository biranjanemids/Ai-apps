# Low-Level Design — Windows LTSC Remote Management Agent + Server

> WMS/Wyse-Device-Agent-class system. Agent: **.NET (C#) Windows Service**.
> Transport: **gRPC bidirectional streaming over mTLS**. Server: **containerized, on-prem + cloud capable**.
> v1 capabilities: **config/policy, app deployment, kiosk/lockdown (UWF/Shell Launcher/Assigned Access), OS update + remote commands, USB imaging, remote BMR**.

---

## 1. Context

Target devices are **Windows 10/11 IoT Enterprise LTSC** thin clients / kiosks. They must be centrally
managed exactly like Dell **Wyse Management Suite (WMS)** + **Wyse Device Agent (WDA/UWDA)**: zero-touch
enroll, group-based desired-state policy, push apps, lock the device down (write filter + kiosk shell),
control Windows Update, run remote commands, and recover a bricked unit via **USB imaging** or
**remote bare-metal recovery (BMR)**. Devices are often behind NAT, intermittently connected, and may have a
write filter that discards changes on reboot — the design must be NAT-friendly, offline-tolerant, and
write-filter-aware. This document is the implementation blueprint for that system.

**Naming used below:** `MgmtServer` (control plane), `Agent` (device service), `RecoveryAgent` (WinPE-side).

---

## 2. System topology

```
                         ┌──────────────────────── MgmtServer (containers) ─────────────────────────┐
                         │  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  │
  Admin ── HTTPS ───────▶│  │ Console UI  │  │  REST/Gateway│  │ gRPC Ingress  │  │  Auth (OIDC) │  │
  (browser)              │  │  (SPA)      │  │  (BFF)       │  │ (stream term.)│  │  RBAC        │  │
                         │  └─────────────┘  └──────┬───────┘  └──────┬────────┘  └──────────────┘  │
                         │                          │                 │                              │
                         │   ┌──────────────────────┴─────────────────┴───────────────────────┐     │
                         │   │  Core services: DeviceRegistry · PolicyService · JobOrchestrator │     │
                         │   │  PackageService · ImageService · EventIngest · CertAuthority    │     │
                         │   └───────┬───────────────┬──────────────┬───────────────┬──────────┘     │
                         │   ┌───────┴────┐  ┌────────┴───┐  ┌───────┴─────┐  ┌──────┴──────┐         │
                         │   │ PostgreSQL │  │   Redis    │  │ Object store│  │ Msg bus     │         │
                         │   │ (state)    │  │(conn map)  │  │(S3/MinIO:   │  │ (NATS)      │         │
                         │   └────────────┘  └────────────┘  │ pkgs+images)│  └─────────────┘         │
                         │                                    └─────────────┘                         │
                         └──────────────────────────────▲───────────────────────────────────────────┘
                                                         │ gRPC bidi stream over mTLS (:443/8443)
                          ┌──────────────────────────────┴───────────────────────────────┐
                          │                       Windows LTSC device                      │
                          │  ┌───────────────── Agent (Windows Service, LocalSystem) ────┐ │
                          │  │ CommChannel · Orchestrator · ModuleHost · LocalStore(SQLite)│ │
                          │  │ Modules: Inventory·Config·App·Kiosk·Update·Command·Image    │ │
                          │  └───────▲───────────────────────────────────────────▲────────┘ │
                          │          │ named-pipe IPC                             │ COM/WMI    │
                          │  ┌───────┴─────────┐                        ┌─────────┴─────────┐ │
                          │  │ SessionAgent    │                        │ Windows subsystems│ │
                          │  │ (per-user, UI,  │                        │ UWF·ShellLauncher·│ │
                          │  │ shadow, kiosk)  │                        │ AssignedAccess·WUA│ │
                          │  └─────────────────┘                        └───────────────────┘ │
                          │  Recovery partition: WinPE + RecoveryAgent (for BMR/FFU apply)     │
                          └───────────────────────────────────────────────────────────────────┘
```

---

## 3. Tech stack

| Layer | Choice |
|---|---|
| Agent runtime | .NET 8 LTS, **self-contained single-file**, `win-x64`/`win-arm64`, AOT-friendly where possible |
| Agent host | `Microsoft.Extensions.Hosting` `BackgroundService` registered as a Windows Service (`UseWindowsService`) |
| Transport | gRPC (`Grpc.Net.Client`), HTTP/2 over TLS 1.3, mTLS client cert auth |
| Local store | SQLite (`Microsoft.Data.Sqlite`), WAL mode, on a UWF-excluded path |
| Windows interop | WMI/CIM (`Microsoft.Management.Infrastructure`), MDM WMI Bridge (`root\cimv2\mdm\dmmap`), DISM API, WUA COM, Win32 P/Invoke |
| Server | ASP.NET Core (gRPC + REST BFF), EF Core, containerized (Docker), Helm for K8s |
| Datastores | PostgreSQL (state), Redis (connection registry / pub-sub), MinIO/S3 (packages + images), NATS JetStream (internal bus) |
| Recovery | WinPE + custom `RecoveryAgent` (.NET or Win32), DISM/FFU, optional WDS/iPXE network boot |
| AuthN/Z | OIDC (Keycloak/Entra) for admins; per-device X.509 (internal CA) for agents; RBAC + audit |

---

## 4. Agent — low-level design

### 4.1 Process model
- **`Agent` service** — runs as `LocalSystem` Windows Service. Owns the gRPC stream, all privileged actions
  (UWF, install, imaging trigger). Single instance, auto-restart (`SC failure` actions).
- **`SessionAgent`** — lightweight per-user-session process launched in the interactive desktop (via
  `WTSEnumerateSessions` + `CreateProcessAsUser`). Handles UI toasts, kiosk shell coordination, remote-assist
  shadow consent, and screen capture. Talks to `Agent` over a **named pipe** (`\\.\pipe\ltsc-agent`) with an
  ACL restricted to `SYSTEM` + the logged-on user; messages are protobuf-framed.
- **`RecoveryAgent`** — lives in the recovery partition's WinPE; only active during BMR.

### 4.2 Internal component graph (one process, DI container)
```
Program → HostBuilder → AgentService (BackgroundService)
   ├── CommChannel        // gRPC connect, stream, reconnect, offline outbox
   ├── Orchestrator       // routes server Commands → Modules; reports results
   ├── ModuleHost         // discovers IManagementModule implementations
   ├── LocalStore         // SQLite: identity, cached policy, command log, outbox
   ├── IdentityProvider   // device cert + enrollment token, mTLS cert rotation
   ├── WriteFilterGuard   // UWF state, servicing-mode bracket (commit/disable→reboot)
   └── Modules : IManagementModule
        Inventory · Config · App · Kiosk · Update · Command · Image
```

### 4.3 Module contract (the extensibility seam)
```csharp
public interface IManagementModule {
    string Capability { get; }                       // "config","app","kiosk","update","command","image"
    Task<ModuleResult> ApplyAsync(CommandEnvelope cmd, IModuleContext ctx, CancellationToken ct);
    Task<DesiredVsActual> ReconcileAsync(PolicySnapshot policy, CancellationToken ct); // drift detection
    Task<JsonNode> CollectInventoryAsync(CancellationToken ct);
}
```
- Modules are **idempotent** desired-state appliers. Each `ApplyAsync` returns a structured `ModuleResult`
  (status, exit code, stdout/stderr tail, `RebootRequired`, `WriteFilterCommitRequired`).
- `IModuleContext` exposes `WriteFilterGuard`, `LocalStore`, progress reporting, and a scoped temp dir on an
  **excluded volume** so installs survive a UWF discard until committed.

### 4.4 Core loop / state machine
```
[Unprovisioned] --enroll--> [Provisioned] --connect--> [Online]
   ^                                                      | stream cmd
   | factory reset                                        v
[Provisioned] <--backoff/offline-- [Reconnecting] <-- [Online] --apply--> reconcile --> report
```
- **Online steady state:** hold an open bidi stream. Server pushes `Command`s; agent streams back
  `Heartbeat`, `Event`, `InventoryDelta`, `CommandResult`, `Progress`.
- **Heartbeat** every N s (configurable, default 60) carries health + policy version hash. If hash differs
  from server's expected → server pushes a `SyncPolicy` command.
- **Reconnect:** exponential backoff w/ jitter (1s→max 5m). While offline, commands the agent generated
  (results/events) buffer in the SQLite **outbox**; flushed on reconnect (at-least-once, dedup by `command_id`).

### 4.5 Write-filter awareness (critical for LTSC)
`WriteFilterGuard` wraps any change that must persist:
1. Query UWF state via WMI (`UWF_Filter`, `UWF_Volume`, `UWF_Overlay`).
2. For a persistent change: enter **servicing window** → either `CommitFile`/`CommitFileDeletion` for narrow
   changes, or `disable filter → reboot → apply → enable → reboot`. Orchestrated as a **multi-stage command**
   with resumable state stored in `LocalStore` so it survives the reboots.
3. Free-space/overlay monitoring → raise `Event` when overlay critical (auto-reboot policy optional).

---

## 5. Communication protocol (gRPC)

Three services. The device link is **one long-lived bidi stream**; bulk bytes go through a separate chunked
file service so they don't block the control stream.

```proto
syntax = "proto3";
package ltsc.mgmt.v1;

// ---- 1. Enrollment (unary, bootstrap mTLS via enrollment token) ----
service Enrollment {
  rpc Enroll(EnrollRequest) returns (EnrollResponse);          // returns signed device cert (CSR-based)
  rpc RenewCertificate(RenewRequest) returns (EnrollResponse); // cert rotation before expiry
}

// ---- 2. Device link (bidi stream; the heart of the system) ----
service DeviceLink {
  rpc Connect(stream AgentMessage) returns (stream ServerMessage);
}
message AgentMessage {
  string device_id = 1;
  oneof payload {
    Heartbeat       heartbeat   = 2;
    CommandResult   result      = 3;   // correlated by command_id
    Progress        progress    = 4;
    Event           event       = 5;   // alerts, drift, overlay-critical
    InventoryDelta  inventory   = 6;
    StreamAck       ack         = 7;
  }
}
message ServerMessage {
  oneof payload {
    CommandEnvelope command = 1;        // config/app/kiosk/update/command/image
    SyncPolicy      sync    = 2;
    StreamAck       ack     = 3;
    ServerHello     hello   = 4;        // session params, heartbeat interval
  }
}
message CommandEnvelope {
  string command_id   = 1;             // ULID; idempotency key
  string capability   = 2;             // routes to module
  string action       = 3;             // e.g. "install","apply_policy","trigger_bmr"
  bytes  spec         = 4;             // capability-specific protobuf/JSON spec
  int64  not_after    = 5;             // expiry
  bytes  signature    = 6;             // server-signed (command signing)
}

// ---- 3. Bulk transfer (chunked, resumable; packages, FFU/WIM images, logs) ----
service Transfer {
  rpc Download(DownloadRequest) returns (stream Chunk);  // server→agent (artifacts)
  rpc Upload(stream Chunk) returns (UploadResult);       // agent→server (captured image, logs)
}
message Chunk { string transfer_id=1; int64 offset=2; bytes data=3; bytes sha256=4; bool last=5; }
```

Design notes:
- **Idempotency:** `command_id` is the dedup key everywhere (server retries, agent reboots).
- **Backpressure:** control stream carries only small messages; large artifacts always via `Transfer` with
  resumable `offset` + per-chunk hash + whole-artifact hash + code-signature verification before use.
- **NAT/firewall:** outbound 443 only; HTTP/2 keepalive pings keep the stream alive through middleboxes.
- **Why gRPC over MQTT (your choice):** strongly-typed contract, bidi streaming gives the same push semantics
  WMS gets from MQTT; trade-off is HTTP/2-aware ingress + sticky stream routing (handled in §8.2).

---

## 6. Enrollment & identity

Mirrors WMS group-token enrollment.

1. **Provision input:** group/enrollment token (`OOBE` config file, USB seed, MDM, or manual) → `Agent`.
2. Agent generates keypair, builds CSR (CN = hardware UUID + TPM-backed key where available), calls
   `Enroll(token, csr, deviceFacts)`.
3. `CertAuthority` validates token → signs short-lived **device cert** (e.g. 90d) → returns cert + CA chain +
   assigned `device_id` + initial group binding.
4. All later calls use **mTLS** with that cert. `RenewCertificate` rotates before expiry (auto).
5. Key stored in Windows **CNG/TPM** (Platform Crypto Provider) so it's non-exportable.
6. **Factory reset / re-enroll** path wipes identity from `LocalStore` and TPM key container.

---

## 7. Configuration & policy engine

- **Model:** `Group → Policy → Profiles`. Groups form a tree; policy resolves by **inheritance + precedence**
  (device override > group > parent group > tenant default). Server computes the **effective desired state**
  per device and ships a versioned `PolicySnapshot` (with content hash).
- **Profile types (v1):** Registry, Wi-Fi/Network, Power & Time/NTP, Certificates/Trust, Firewall, Local
  users/groups, Branding/wallpaper, plus references to App/Kiosk/Update profiles.
- **Reconcile loop:** every heartbeat compares local `policy_version` hash; on mismatch pulls snapshot and each
  module runs `ReconcileAsync` → applies only drifted items (desired-state, idempotent).
- **Windows specifics:**
  - Registry: typed values via WMI StdRegProv / direct API; UWF-bracketed if persistent.
  - Wi-Fi: WLAN profile XML via `netsh wlan add profile` / Native WiFi API; secrets delivered encrypted.
  - Certs: import into LocalMachine stores via CertEnroll/CryptoAPI.
  - Power/time: powercfg + W32Time config.

---

## 8. App deployment subsystem

- **Spec:** installer type (`msi|exe|msix|script`), artifact ref (Transfer id + hash + signature), install/
  uninstall command lines, **detection rules** (file version, MSI product code, registry, MSIX package family),
  **applicability rules** (OS build, arch), success exit codes (e.g. `0,1641,3010`), reboot behavior, order/deps.
- **Flow:** detect (skip if present) → `WriteFilterGuard` servicing bracket → download to excluded temp →
  verify hash+signature → execute (msiexec/exe/Add-AppxProvisionedPackage) → re-run detection → report
  `CommandResult{exit_code, reboot_required}` → commit/enable UWF.
- **Reboot orchestration:** `3010`/`1641` surfaced to Orchestrator; reboot honored per maintenance-window policy.

---

## 9. Kiosk / lockdown subsystem (IoT LTSC)

| Feature | Mechanism (low level) |
|---|---|
| **Unified Write Filter (UWF)** | WMI `root\standardcimv2\embedded`: `UWF_Filter.Enable/Disable`, `UWF_Volume.Protect`, `UWF_RegistryFilter`, `UWF_Overlay` monitoring, file/dir exclusions, servicing mode. |
| **Shell Launcher v2** | MDM WMI Bridge `root\cimv2\mdm\dmmap` `MDM_AssignedAccess` / Shell Launcher CSP; set custom shell per user/SID, default-return-action on shell exit. |
| **Assigned Access (kiosk)** | AssignedAccess CSP via MDM bridge (push `Configuration`/`ShellLauncher` XML) or `Set-AssignedAccess`/`MDM_AssignedAccess` WMI; single-app UWP or multi-app kiosk + auto-logon account. |
| **Keyboard Filter** | WMI `root\standardcimv2\embedded` `WEKF_*` (blocked key combos, breakout, custom scancodes). |
| **AppLocker** | MDM AppLocker CSP / `Set-AppLockerPolicy`; allow/deny by publisher/path/hash; enforce kiosk app whitelist. |
| **Branding/OOBE/auto-logon** | Registry + Shell Launcher; auto-logon via LSA secret (encrypted). |

All lockdown changes route through `WriteFilterGuard` and a **two-phase apply** so a bad kiosk config can't
permanently lock out management (a recovery/breakout SID + a "config heartbeat watchdog" that reverts to last-
known-good if the device fails to check in within a grace window).

---

## 10. OS update + remote commands

- **Windows Update control:** WUA COM (`IUpdateSession`/`IUpdateSearcher`/`IUpdateInstaller`) for scan/
  download/install with policy (deferral, ring, maintenance window), or policy-driven via `UsoClient`/CSP.
  Feature-update gating by target build. Reboot orchestrated, UWF disabled across the servicing reboot then
  re-enabled (multi-stage resumable command).
- **Remote commands:** `reboot`, `shutdown`, `wake` (Wake-on-LAN sent by a peer agent on the same subnet, since
  the target is off), `run_script` (PowerShell/cmd, signed, sandboxed, output captured), `collect_logs`
  (zips + `Transfer.Upload`), `factory_reset`, **`shadow`/remote-assist** (SessionAgent streams framebuffer over
  the Transfer stream with on-screen consent + RBAC + full audit).
- **Telemetry/inventory:** hardware (WMI Win32_*), OS build, installed apps, disk/overlay, UWF state, policy
  version, agent version, kiosk state → full snapshot on enroll + heartbeat-driven **deltas**.

---

## 11. Imaging & BMR subsystem (USB + remote bare-metal recovery)

This is the Dell "Merlin"/WIE-imaging + USB-Imaging-Tool equivalent. **FFU** is the primary format (full-disk,
fast, sector-based) with WIM supported for file-based capture.

### 11.1 Golden-image capture (from a reference device)
- Server sends `image.capture` command → Agent boots to recovery context or uses DISM offline:
  `DISM /Capture-FFU /ImageFile=disk.ffu /CaptureDrive=\\.\PhysicalDrive0` (or `/Capture-Image` for WIM).
- Agent streams the artifact to server via `Transfer.Upload`; `ImageService` stores it in object store with
  metadata (model, OS build, sysprep state, hash, signature) → becomes an assignable **image artifact**.

### 11.2 USB imaging media (offline / first-touch / dead-network recovery)
- Admin selects image + target model in Console → `ImageService` builds a **bootable USB payload**:
  WinPE + `RecoveryAgent` + FFU + an `unattend`/seed file (enrollment token, target group, server URL).
- Output: ISO/USB image the admin writes with the built-in **USB Imaging Tool** (or `dd`/Rufus-style writer).
- Boot from USB → `RecoveryAgent` wipes/repartitions → `DISM /Apply-FFU` → injects seed → first boot
  auto-enrolls (§6) into the assigned group. Fully offline-capable.

### 11.3 Remote BMR (network, no USB)
- Every managed device carries a **recovery partition**: WinPE + `RecoveryAgent` registered as a boot entry
  (`bcdedit`), so it can be selected without local hands.
- Server sends `image.trigger_bmr{image_id, wipe_policy}` → Agent stages the FFU (or just sets it to pull),
  sets one-time boot to the recovery partition (`bcdedit /bootsequence`), reboots.
- `RecoveryAgent` (WinPE) connects to server (mTLS, recovery-scoped cert), `Transfer.Download`s the FFU
  (resumable), verifies signature, `DISM /Apply-FFU` to the disk, applies seed, reboots to OS → auto-enroll.
- **Resumability:** BMR is a state machine persisted to the recovery partition (`Triggered → Booted → Pulling
  → Applying → Sealing → Rejoining → Done/Failed`) so a mid-apply power loss resumes, not bricks.
- **Optional network boot:** WDS/PXE or **iPXE** boot of WinPE for devices with no/blown recovery partition
  (documented as deployment option; requires DHCP/PXE on-site).

### 11.4 BMR safety rails
- Image↔model compatibility check before wipe; explicit "wipe" confirmation + RBAC scope; per-device dry-run;
  hard timeout that reverts boot order to OS if WinPE can't reach server (avoids stranding the device).

---

## 12. Server — low-level design

### 12.1 Core services (independent containers / modules)
| Service | Responsibility |
|---|---|
| **gRPC Ingress** | Terminates mTLS, validates device cert, owns the bidi `DeviceLink` streams. |
| **DeviceRegistry** | Device records, group membership, cert/identity, last-seen, health. |
| **PolicyService** | Group tree, policy resolution → versioned `PolicySnapshot` + hash. |
| **JobOrchestrator** | Turns admin intents into per-device `Command`s; tracks lifecycle, retries, schedules, maintenance windows, fan-out to thousands of devices. |
| **PackageService** | App artifact CRUD, detection-rule metadata, signing. |
| **ImageService** | FFU/WIM capture intake, USB-media builder, BMR job driver. |
| **EventIngest** | Heartbeats, events, inventory deltas → state + alerts. |
| **CertAuthority** | Enrollment tokens, device cert issue/renew/revoke (internal PKI; can chain to org CA). |
| **REST BFF + Console** | Admin API + SPA (groups, policies, devices, jobs, images, audit). |
| **Auth/RBAC** | OIDC for admins; role/scoped permissions; full audit log. |

### 12.2 Connecting device streams at scale
- gRPC streams are **stateful + sticky**. A **ConnectionRegistry in Redis** maps `device_id → ingress_pod`.
- To command a device, JobOrchestrator publishes to **NATS** subject `dev.<device_id>`; the owning ingress pod
  subscribes and writes the `ServerMessage` onto that device's open stream. Lets any service reach any device
  without knowing which pod holds the socket. Horizontal scale = more ingress pods.

### 12.3 Data model (PostgreSQL, key tables)
```
tenants(id, name)
devices(id, tenant_id, hw_uuid, cert_serial, model, os_build, group_id,
        agent_version, last_seen, health, policy_version, kiosk_state, status)
groups(id, tenant_id, parent_id, name, enrollment_token_hash)
policies(id, group_id, type, version, content_hash, body)        -- effective state computed per device
packages(id, type, version, artifact_uri, sha256, signature, detect_rules, applicability)
images(id, format/*ffu|wim*/, model, os_build, artifact_uri, sha256, signature, sysprep)
jobs(id, intent, target_query, schedule, maintenance_window, status, created_by)
commands(id /*ULID*/, job_id, device_id, capability, action, spec, status,
         exit_code, result, attempts, not_after, signature)       -- idempotency by id
events(id, device_id, type, severity, payload, ts)
audit(id, actor, action, target, ts, detail)
```
- Artifacts (packages, FFU/WIM, USB payloads, log bundles) live in **MinIO/S3**, DB stores refs + hashes.

### 12.4 Deployment (containerized, on-prem + cloud)
- `docker-compose` for single-node on-prem (WMS-Standard analog); **Helm chart** for K8s/cloud
  (WMS-Pro/SaaS analog). Externalize PostgreSQL/Redis/object-store as managed services in cloud.
- Multi-tenancy via `tenant_id` row scoping + per-tenant CA namespace (toggle for SaaS mode).

---

## 13. Security model

- **Transport:** TLS 1.3 everywhere; **mTLS** for all agent↔server (device cert) and recovery↔server traffic.
- **Identity:** TPM/CNG-backed non-exportable device keys; short-lived certs with auto-rotation + revocation.
- **Command signing:** every `CommandEnvelope` server-signed; agent verifies before executing (defends a
  compromised transport from injecting commands).
- **Artifact integrity:** packages + images carry SHA-256 + code signature; agent verifies before install/apply.
- **RBAC + audit:** scoped admin roles; immutable audit of every command, enrollment, BMR, shadow session.
- **Lockdown safety:** kiosk/UWF watchdog reverts to last-known-good if device can't check in (anti-lockout);
  shadow requires on-device consent policy + audit.

---

## 14. Recommended repo / solution layout

```
/agent
  /Ltsc.Agent.Service        (BackgroundService host, Orchestrator, CommChannel, LocalStore)
  /Ltsc.Agent.Modules        (Inventory, Config, App, Kiosk, Update, Command, Image)
  /Ltsc.Agent.Interop        (UWF, ShellLauncher, AssignedAccess, WUA, DISM wrappers)
  /Ltsc.SessionAgent         (per-user UI/shadow process)
  /Ltsc.RecoveryAgent        (WinPE-side BMR/FFU)
/server
  /Ltsc.Server.Ingress       (gRPC DeviceLink + Transfer)
  /Ltsc.Server.Core          (DeviceRegistry, PolicyService, JobOrchestrator, ImageService...)
  /Ltsc.Server.Bff           (REST + Console SPA)
  /Ltsc.Server.Ca            (CertAuthority)
/proto                       (ltsc.mgmt.v1 .proto — shared contract; codegen for C# both sides)
/deploy                      (docker-compose, Helm chart, WinPE build scripts, USB-media builder)
/docs                        (this design, runbooks)
```

---

## 15. Implementation phases (suggested milestones)

1. **M0 Contract + skeleton:** `/proto`, mTLS enrollment, DeviceLink stream, heartbeat, DeviceRegistry, Console
   device list. (Online dot lights up.)
2. **M1 Config + inventory:** PolicyService + Config module + WriteFilterGuard + reconcile loop.
3. **M2 App deployment:** PackageService + Transfer + App module (detection/exit-codes/reboot).
4. **M3 Kiosk/lockdown:** UWF, Shell Launcher, Assigned Access, Keyboard Filter, AppLocker + watchdog.
5. **M4 Update + remote commands:** WUA control, reboot/shutdown/WoL, run_script, shadow, log collection.
6. **M5 Imaging/BMR:** ImageService capture, USB-media builder, RecoveryAgent + remote BMR state machine.
7. **M6 Scale/HA:** Redis ConnectionRegistry + NATS fan-out, Helm chart, multi-tenant + RBAC + audit hardening.

---

## 16. Verification

- **Contract:** generate C# stubs from `/proto`; round-trip an enrollment + heartbeat against a stub server.
- **Agent unit:** mock `IModuleContext`; assert each module is idempotent (apply twice → second is no-op) and
  UWF-bracketed changes resume across a simulated reboot.
- **Integration (VM lab):** Windows IoT Enterprise LTSC VM + containerized server via docker-compose; run each
  capability end-to-end (push registry policy, install an MSI, enable kiosk, force a WU scan, run a script).
- **Imaging/BMR:** capture FFU from a reference VM → build USB media → apply to a blank VM → confirm auto-enroll;
  trigger remote BMR on a managed VM → confirm recovery-partition boot, FFU pull/apply, rejoin.
- **Resilience:** kill the network mid-stream (outbox flush on reconnect), power-loss mid-BMR (state resumes),
  bad kiosk config (watchdog reverts), wrong-model image (compat check blocks wipe).
- **Security:** tamper a command signature / artifact hash → agent rejects; expired device cert → re-enroll path.

---

## 17. Open assumptions (flag if wrong)
- FFU is the primary image format (WIM optional); devices have/can-create a recovery partition for remote BMR
  (PXE/iPXE is the fallback for those that don't).
- Internal CA for device certs is acceptable (can chain to an existing org PKI).
- Single shared design doc now; code scaffolding follows in M0 once approved.

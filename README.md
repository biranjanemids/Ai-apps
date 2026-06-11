# Ai-apps — Windows LTSC remote management agent + server

A devicemanagment system for managing Windows IoT Enterprise LTSC
thin clients from a central server. See the full low-level design in
[`docs/windows-ltsc-agent-design.md`](docs/windows-ltsc-agent-design.md).

This repository contains a runnable gRPC server and agent covering two
capabilities end-to-end: the **App-deployment install state machine** (design §8)
and the **config / manageability reconcile loop** (design §7/§9) —
enroll → stream → heartbeat → command/policy → apply → status reporting.

> **Build status:** builds clean with the .NET 8 SDK, 16/16 tests pass, and the
> demo below runs end-to-end on Linux **over mTLS**: CSR-based enrollment issues
> a CA-signed device certificate, the agent pins the CA, commands are
> server-signed and verified before execution, artifacts are SHA-256-verified
> before install, config reconciles idempotently, and the fleet survives a
> server restart (SQLite). Negative paths verified: plain HTTP refused, invalid
> enrollment token rejected, tampered command/artifact rejected.

## Layout

```
proto/                     gRPC contract (ltsc.mgmt.v1): Enrollment, DeviceLink, Transfer, InstallSpec
src/Ltsc.Contracts/        Shared generated stubs (GrpcServices=Both)
src/Ltsc.Server/           ASP.NET Core gRPC server (in-process control plane)
src/Ltsc.Agent/            .NET worker / Windows service agent
  Comm/CommChannel.cs        enrollment + DeviceLink bidi stream + outbox + policy pull
  Orchestrator.cs            routes commands/policy to modules, reports results (IModuleContext)
  Modules/AppModule.cs       App-deployment install state machine (design §8)
  Modules/ConfigModule.cs    config/manageability reconcile loop (design §7/§9)
  Platform/                  Windows behaviors behind interfaces + cross-platform stubs
  Platform/Windows/          real WMI/registry/UWF interop (net8.0-windows only)
  Storage/LocalStore.cs      SQLite identity + resumable install jobs + applied policy version
deploy/                    docker-compose, server Dockerfile
```

The Windows-only behaviors (UWF/WMI, registry, msiexec/DISM, WTS session UI) sit
behind interfaces in `src/Ltsc.Agent/Platform/` with **cross-platform stubs**, so
the agent builds, tests, and demos on Linux/macOS. The **real Windows
implementations** live in `src/Ltsc.Agent/Platform/Windows/` and are compiled only
for the `net8.0-windows` target (built on Windows / the windows CI leg, selected
at runtime via `OperatingSystem.IsWindows()`).

## Configuration you can apply (ConfigModule)

The server ships a versioned `PolicySnapshot` of typed profiles; the agent pulls
it on a `SyncPolicy` signal and reconciles desired-state (applies only drift,
idempotent, UWF-bracketed for persistent writes). Profile types: **registry,
UWF write-filter, kiosk (Shell Launcher / Assigned Access), Wi-Fi, power, time/
NTP, certificates, AppLocker, keyboard filter**. The applied policy hash is
reported in heartbeats so the server can detect drift and re-trigger reconcile.

## Run the demo (two terminals)

```bash
# 1) Server — gRPC over h2c on :8080
dotnet run --project src/Ltsc.Server

# 2) Agent — enrolls, opens the stream, heartbeats; server pushes a demo install
dotnet run --project src/Ltsc.Agent
```

Expected, on the server log:
- **Config reconcile** — `GetPolicy` (3 profiles) then per-profile progress
  `Registry → Uwf → Kiosk` → `Reconciled (3 applied)` → `Succeeded`; a second
  pass reports every profile `in desired state` / `no drift` (idempotent).
- **App install** — `Progress` stages
  (`Scheduled → PreCheck → EnterServicing → Downloading → Installing →
  ConfiguringApp → Verifying → ExitServicing → PendingReboot → PostRebootVerify`)
  then the terminal `CommandResult`. The stub installer returns `3010`, so you see
  the `InstalledPendingReboot` interim status and the separate reboot handling.

## Capabilities (implemented)

- **App deployment** (`AppModule`) — scheduling, user deferral, reboot policy,
  UWF-bracketed install, verified artifact download, config-verify, status.
- **Config / manageability** (`ConfigModule`) — desired-state reconcile of
  registry, UWF, kiosk, network, power, time, certs, AppLocker, keyboard filter.
- **Inventory** (`InventoryModule`) — hardware + OS asset report (cross-platform,
  real data) at startup and on demand; viewable at `/api/devices/{id}/inventory`.
- **Remote commands** (`CommandModule`) — `reboot`, `shutdown`, `restart_services`,
  `run_script`, `collect_logs`, `wake` (WoL). Power actions are gated behind
  `LTSC_ALLOW_POWER=1` so demo/CI hosts are safe. Issue them from the console:
  `POST /api/devices/{id}/command?action=...` (signed + pushed); results at
  `/api/devices/{id}/commands`.

See [`docs/COMPETITIVE-ANALYSIS.md`](docs/COMPETITIVE-ANALYSIS.md) for the feature
parity matrix vs. Dell WMS, HP Device Manager, IGEL UMS, Workspace ONE, and Intune.

## Security model (implemented)

- **mTLS everywhere** — TLS-only Kestrel (:8443); enrollment is the single
  anonymous RPC: agent submits a PKCS#10 CSR + group token, the internal CA
  (`src/Ltsc.Server/Ca/CertAuthority.cs`) signs a 90-day device cert; every
  other RPC requires a CA-chained client certificate (`DeviceAuth`).
- **CA pinning** — the agent stores the CA from enrollment and validates the
  server against it (TOFU only for the bootstrap enrollment call).
- **Command signing** — every `CommandEnvelope` is ECDSA-signed by the CA key
  (`src/Ltsc.Contracts/CommandSigning.cs`); the agent rejects unsigned or
  tampered commands before dispatch.
- **Artifact integrity** — downloads verify per-chunk and whole-file SHA-256
  against the hash in the signed install spec; mismatch fails the install
  closed, the installer never runs.
- Admin console (`/console`, `/api/devices`) is read-only and unauthenticated
  in this scaffold — put OIDC in front before any real deployment.

## Honest gaps that remain before production

- **Windows-device validation** — the `net8.0-windows` WMI/registry/UWF
  appliers compile but have never executed on real LTSC hardware; the full UWF
  disable→reboot→re-enable servicing cycle still needs wiring + a device lab.
- **Key storage** — device private key persists as PFX in SQLite; on Windows it
  belongs in TPM/CNG. CA key belongs in an HSM. No revocation (CRL/OCSP) yet.
- **Scale** — SQLite/single-node by design here; PostgreSQL + Redis + NATS for
  multi-node (design §12). Policy authoring is code-seeded, no editor UI.
- **Capabilities not yet built** — real installer execution/detection on
  Windows, OS update (WUA), remote commands/shadow, imaging/BMR, inventory,
  agent MSI packaging/code-signing/self-update, RBAC + audit.

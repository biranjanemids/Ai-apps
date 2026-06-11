# Ai-apps — Windows LTSC remote management agent + server

A WMS / Wyse-Device-Agent-class system for managing Windows IoT Enterprise LTSC
thin clients from a central server. See the full low-level design in
[`docs/windows-ltsc-agent-design.md`](docs/windows-ltsc-agent-design.md).

This repository contains a runnable gRPC server and agent covering two
capabilities end-to-end: the **App-deployment install state machine** (design §8)
and the **config / manageability reconcile loop** (design §7/§9) —
enroll → stream → heartbeat → command/policy → apply → status reporting.

> **Build status:** builds clean with the .NET 8 SDK (`dotnet build Ltsc.sln`) and
> the demo below has been run end-to-end on Linux — the agent enrolls, opens the
> DeviceLink stream, receives the pushed install, and drives the full state
> machine through to `Succeeded` (exit 3010 → `InstalledPendingReboot` →
> `PostRebootVerify` → `Succeeded`, UWF re-enabled).

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

## What this scaffold deliberately stubs (next milestones)

- **mTLS + real CA** — enrollment issues a session token, not a signed device
  cert yet (design §6, §13).
- **Artifact download** — `Transfer` serves a synthetic payload; the App module
  doesn't yet stream/verify the real installer bytes.
- **Windows interop** — the real WMI/registry/UWF appliers compile on
  `net8.0-windows` but are validated on real LTSC devices; the cross-platform
  build/tests run the stubs (design §4.5, §7, §9).
- **Persistence/scale** — registries/policy are in-process; PostgreSQL / Redis /
  NATS / MinIO are wired in a later milestone (design §12).

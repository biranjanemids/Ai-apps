# Ai-apps — Windows LTSC remote management agent + server

A WMS / Wyse-Device-Agent-class system for managing Windows IoT Enterprise LTSC
thin clients from a central server. See the full low-level design in
[`docs/windows-ltsc-agent-design.md`](docs/windows-ltsc-agent-design.md).

This repository currently contains the **M0 scaffold plus the App-deployment
state machine** (design §8): a runnable gRPC server and agent that demonstrate
enroll → stream → heartbeat → command → install state machine → status reporting.

> **Build status:** not built/verified in CI yet — the development container has
> no network egress to restore NuGet/.NET. Run the commands below where you have
> the .NET 8 SDK and network access.

## Layout

```
proto/                     gRPC contract (ltsc.mgmt.v1): Enrollment, DeviceLink, Transfer, InstallSpec
src/Ltsc.Contracts/        Shared generated stubs (GrpcServices=Both)
src/Ltsc.Server/           ASP.NET Core gRPC server (in-process control plane)
src/Ltsc.Agent/            .NET worker / Windows service agent
  Comm/CommChannel.cs        enrollment + DeviceLink bidi stream + outbox
  Orchestrator.cs            routes commands to modules, reports results (IModuleContext)
  Modules/AppModule.cs       App-deployment install state machine (design §8)
  Platform/                  Windows behaviors behind interfaces + cross-platform stubs
  Storage/LocalStore.cs      SQLite identity + resumable install jobs
deploy/                    docker-compose, server Dockerfile
```

The Windows-only behaviors (UWF/WMI, msiexec/DISM, WTS session UI) sit behind
interfaces in `src/Ltsc.Agent/Platform/` with **stub implementations** so the
agent and its state machine build and run on Linux/macOS for demos and tests.
Swap in the Windows implementations (and a `net8.0-windows` TFM) for production.

## Run the demo (two terminals)

```bash
# 1) Server — gRPC over h2c on :8080
dotnet run --project src/Ltsc.Server

# 2) Agent — enrolls, opens the stream, heartbeats; server pushes a demo install
dotnet run --project src/Ltsc.Agent
```

Expected: the server logs the enrollment and each install **Progress** stage
(`Scheduled → PreCheck → EnterServicing → Downloading → Installing →
ConfiguringApp → Verifying → ExitServicing → PendingReboot → PostRebootVerify`)
followed by the terminal **CommandResult**. The stub installer returns `3010`,
so you'll see the `InstalledPendingReboot` interim status and the separate
reboot handling (design §8.4).

## What this scaffold deliberately stubs (next milestones)

- **mTLS + real CA** — enrollment issues a session token, not a signed device
  cert yet (design §6, §13).
- **Artifact download** — `Transfer` serves a synthetic payload; the App module
  doesn't yet stream/verify the real installer bytes.
- **Windows interop** — UWF servicing, installer execution, detection rules, and
  the SessionAgent deferral UI are stubs (design §4.5, §8.5, §8.6, §9).
- **Persistence/scale** — registries are in-process; PostgreSQL / Redis / NATS /
  MinIO are wired in a later milestone (design §12).

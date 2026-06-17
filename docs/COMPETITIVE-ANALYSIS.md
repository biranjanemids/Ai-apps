# Competitive analysis — endpoint/thin-client management

How this project (codename **Ltsc**) compares to the established players, and an
honest parity tracker. This is the reference for "match the features they
provide." It is a living document — status reflects what is actually in the repo.

## Market players surveyed

| Product | Vendor | Primary fleet |
|---|---|---|
| Wyse Management Suite (WMS) | Dell | Wyse/OptiPlex thin clients, ThinOS + Win IoT |
| HP Device Manager (HPDM) / HP Anyware | HP / Teradici | HP thin clients, ThinPro + Win IoT |
| IGEL UMS | IGEL | IGEL OS endpoints |
| Workspace ONE UEM | Omnissa (ex-VMware) | Broad UEM incl. Win IoT |
| Intune | Microsoft | Windows/MDM (incl. IoT Enterprise) |
| Stratodesk NoTouch | Stratodesk | OS + management for repurposed/thin endpoints |
| 10ZiG Manager | 10ZiG | 10ZiG thin/zero clients |

## Feature matrix (✅ done · 🟡 partial · 🟩 designed not built · ❌ none)

| Capability | WMS | HPDM | IGEL | WS1 | Intune | **Ltsc** |
|---|---|---|---|---|---|---|
| Auto-enrollment / group tokens | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| mTLS device identity / PKI | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Signed commands / artifacts | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Group-based desired-state policy | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (config reconcile) |
| Registry / OS settings profiles | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Write-filter (UWF) management | ✅ | ✅ | n/a | 🟡 | 🟡 | 🟡 (logic ✅, device-validated ❌) |
| Kiosk / Shell Launcher / Assigned Access | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 (wired, device-validated ❌) |
| App deployment (MSI/EXE/MSIX) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (state machine; real installer exec ❌) |
| Scheduling + user deferral + reboot policy | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Inventory / hardware+software asset | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Remote commands (reboot/shutdown/WoL) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Remote script execution | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Service restart (no full reboot) | ✅ | ✅ | ✅ | 🟡 | 🟡 | ✅ |
| Log collection | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Remote shadow / remote assist | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 (consent + frame streaming + audit ✅; real screen capture/viewer device-validated ❌) |
| OS / firmware update control (WUA) | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 (scan/install/ring/defer/reboot ✅; WUA COM device-validated ❌) |
| Imaging / BMR (USB + network) | ✅ | ✅ | ✅ | 🟡 | ❌ | 🟡 (capture+BMR state machine ✅; DISM/WinPE device-validated ❌) |
| Admin web console | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (SPA: fleet, device detail tabs, role-gated actions, policy editor, audit) |
| RBAC + audit | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (token roles Viewer/Operator/Admin + persisted audit log) |
| Alerting / health monitoring | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (rule engine: overlay-critical, command-failed, error events, revocation; tenant-scoped feed) |
| Multi-tenant / HA scale | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ (PostgreSQL + Redis multi-node + tenant isolation across devices/policy/audit) |
| OEM-agnostic (mixed fleets) | ❌ | ❌ | 🟡 | ✅ | ✅ | ✅ (by design) |
| Modern typed API (gRPC) | ❌ | ❌ | 🟡 | 🟡 | ✅ | ✅ |
| Container-native on-prem | 🟡 | ❌ | 🟡 | 🟡 | n/a | ✅ |

## Where Ltsc already differentiates
- **OEM-agnostic** control plane (WMS=Dell-only, HPDM=HP-only) with a **modern
  typed gRPC contract** and **true desired-state reconciliation** (most incumbents
  are imperative push), shipped **container-native** for on-prem.

## Honest gaps vs. incumbents (priority order)
1. **Windows-device validation** of UWF/kiosk/installer/inventory/**WUA**/**DISM-FFU**
   interop (needs a hardware lab — the logic exists and is tested with stubs).
2. **True multi-replica deployment testing** (PostgreSQL shared state, Redis
   presence/routing, and tenant isolation are built + verified single-process).
3. **Signed MSI build + Authenticode** (self-update + WiX authoring + win-x64
   packaging are built; building/signing the .msi needs a Windows CI agent + cert).
4. **WinPE RecoveryAgent** for offline-USB BMR (network BMR + USB media builder built).
5. **Real screen capture + viewer** for shadow (session/consent/streaming/audit built).
6. **TPM/CNG device-key storage** (key is file-backed; TPM needs Windows hardware).

Closed since last revision: **cert revocation (CRL)**, **alert rule engine**,
**OIDC (JWT) console auth**, and **app-package authoring + assignment** (catalog,
group assignment, on-connect dispatch, console Apps tab) are implemented and tested.

These are tracked here and in `docs/windows-ltsc-agent-design.md` (§10–§13). Each
PR that closes one updates the matrix above.

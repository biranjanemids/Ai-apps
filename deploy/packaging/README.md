# Agent packaging & self-update

## Self-update (built + tested)
The server advertises the latest agent release in `ServerHello`
(`Ltsc:AgentRelease:Version`, default `0.1.0`). When it's **newer** than the
device's running agent, the agent downloads the package via the `Transfer`
service (per-chunk + whole-file SHA-256 verified) and applies it through
`IAgentUpdater`. On Windows that's `msiexec /i <pkg> /qn` + service restart; the
cross-platform default stages the verified package. Version gating is unit-tested.

Trigger it: run the server with `Ltsc__AgentRelease__Version=0.2.0` and the
`0.1.0` agent self-updates on connect (emits `agent.self_update.applied`).

## Packaging
- **`build-agent-package.sh [version]`** — publishes the agent self-contained
  (`win-x64`, single file) and zips it. Runs on Linux/CI; this is the payload an
  MSI wraps and the artifact the server serves for self-update.
- **`agent.wxs`** — WiX v4 authoring that installs the agent as the `LtscAgent`
  Windows service (LocalSystem, auto-start, crash-restart) with clean upgrade/
  uninstall. Build on Windows:

  ```powershell
  ./build-agent-package.sh 0.2.0           # or dotnet publish ... -o publish\
  wix build agent.wxs -d PublishDir=publish\agent-0.2.0-win-x64 -o LtscAgent.msi
  signtool sign /fd SHA256 /a LtscAgent.msi   # code-signing — required for fleets
  ```

## Not done here (needs Windows / signing infra)
Building the actual `.msi` (WiX runs on Windows) and Authenticode code-signing
require a Windows build agent + signing certificate. The authoring + payload
pipeline are provided; wire them into a Windows CI job to emit a signed MSI.

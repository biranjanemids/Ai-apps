#!/usr/bin/env bash
# Publishes the agent as a self-contained win-x64 service binary and zips it.
# This is the payload an MSI wraps; runs cross-platform (CI/Linux), no Windows needed.
# Usage: build-agent-package.sh [version]
set -euo pipefail

VERSION="${1:-0.2.0}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/artifacts/agent-$VERSION-win-x64"
ZIP="$ROOT/artifacts/agent-$VERSION-win-x64.zip"

echo "Publishing agent $VERSION (win-x64, self-contained)..."
dotnet publish "$ROOT/src/Ltsc.Agent/Ltsc.Agent.csproj" \
  -c Release -r win-x64 --self-contained true \
  -p:PublishSingleFile=true -p:Version="$VERSION" \
  -o "$OUT"

echo "Zipping -> $ZIP"
rm -f "$ZIP"
( cd "$OUT" && zip -qr "$ZIP" . )

echo "SHA-256:"
sha256sum "$ZIP"
echo "Done. Feed $ZIP to WiX (agent.wxs) to build the signed MSI on Windows,"
echo "or serve it from the server ArtifactStore as agent-pkg-$VERSION for self-update."

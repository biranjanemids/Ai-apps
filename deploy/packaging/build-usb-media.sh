#!/usr/bin/env bash
# Assembles an offline USB imaging payload (design §11.2): a WinPE-bootable layout
# carrying an FFU/WIM image + a first-boot seed (server URL, enrollment token,
# target group) so a freshly imaged device auto-enrolls. Runs on Linux/CI to
# produce the payload layout + manifest; writing a *bootable* USB additionally
# needs the Windows ADK (WinPE) — see the README. The image bytes here are a
# placeholder; in production the server streams the real FFU.
#
# Usage: build-usb-media.sh <image-id> <server-url> <enrollment-token> <group> [image-file]
set -euo pipefail
IMG="${1:?image-id}"; SERVER="${2:?server-url}"; TOKEN="${3:?enrollment-token}"; GROUP="${4:?group}"
IMGFILE="${5:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/artifacts/usb-media-$IMG"
rm -rf "$OUT"; mkdir -p "$OUT/sources" "$OUT/winpe"

# First-boot seed consumed by the RecoveryAgent after DISM /Apply-FFU.
cat > "$OUT/seed.json" <<JSON
{
  "serverAddress": "$SERVER",
  "enrollmentToken": "$TOKEN",
  "group": "$GROUP",
  "imageId": "$IMG",
  "applyMode": "full"
}
JSON

# Image payload (placeholder unless a real FFU is supplied).
if [ -n "$IMGFILE" ] && [ -f "$IMGFILE" ]; then cp "$IMGFILE" "$OUT/sources/$IMG.ffu";
else echo "FFU-PLACEHOLDER image=$IMG" > "$OUT/sources/$IMG.ffu"; fi
SHA=$(sha256sum "$OUT/sources/$IMG.ffu" | cut -d' ' -f1)

cat > "$OUT/winpe/README.txt" <<TXT
Boot stub: build WinPE with the Windows ADK (copype + MakeWinPEMedia) and add the
RecoveryAgent (src/Ltsc.RecoveryAgent — scaffold) to \\Windows\\System32\\startnet.cmd.
On boot it applies sources\\$IMG.ffu via DISM /Apply-FFU, injects seed.json, reboots.
TXT

cat > "$OUT/manifest.json" <<JSON
{ "imageId": "$IMG", "sha256": "$SHA", "server": "$SERVER", "group": "$GROUP",
  "files": ["seed.json", "sources/$IMG.ffu", "winpe/README.txt"] }
JSON

( cd "$ROOT/artifacts" && zip -qr "usb-media-$IMG.zip" "usb-media-$IMG" )
echo "USB media payload: $OUT"
echo "Zip: $ROOT/artifacts/usb-media-$IMG.zip"
echo "Image SHA-256: $SHA"

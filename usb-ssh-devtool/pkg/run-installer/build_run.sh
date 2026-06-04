#!/bin/bash
# Builds usb-ssh-devtool.pkg — a self-extracting single-file installer for Ubuntu.
# Works on any Linux machine. No root required to build.
#
# Usage: ./build_run.sh [--version 1.0.0]
#
# Output: usb-ssh-devtool_<version>.pkg
# Install on target: sudo ./usb-ssh-devtool_<version>.pkg

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="1.0.0"
PAYLOAD_DIR="$SCRIPT_DIR/payload"
STUB="$SCRIPT_DIR/stub.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

OUTPUT="$SCRIPT_DIR/usb-ssh-devtool_${VERSION}.pkg"

echo "[1/3] Packing payload into tar.gz ..."
TMPTAR=$(mktemp /tmp/devtool-payload-XXXXXX.tar.gz)
tar -czf "$TMPTAR" -C "$PAYLOAD_DIR" .

echo "[2/3] Encoding and appending to stub ..."
# Write stub (everything up to and including __PAYLOAD__ marker)
cp "$STUB" "$OUTPUT"
# Append base64-encoded payload
base64 "$TMPTAR" >> "$OUTPUT"
rm "$TMPTAR"

chmod +x "$OUTPUT"

echo "[3/3] Done."
echo ""
echo "┌────────────────────────────────────────────────────────────────┐"
echo "│  Self-extracting installer built                               │"
echo "├────────────────────────────────────────────────────────────────┤"
printf "│  File   : %-52s│\n" "$(basename "$OUTPUT")"
printf "│  Size   : %-52s│\n" "$(du -sh "$OUTPUT" | cut -f1)"
echo "├────────────────────────────────────────────────────────────────┤"
echo "│  Copy to USB drive, then on the target Ubuntu machine run:     │"
printf "│    sudo ./%-53s│\n" "$(basename "$OUTPUT")"
echo "│                                                                │"
echo "│  Options:                                                      │"
echo "│    --port 2222       custom SSH port                           │"
echo "│    --user myuser     custom recovery username                  │"
echo "│    --uninstall       remove everything                         │"
echo "└────────────────────────────────────────────────────────────────┘"

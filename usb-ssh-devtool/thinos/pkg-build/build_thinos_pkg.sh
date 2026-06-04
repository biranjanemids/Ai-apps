#!/bin/bash
# Builds usb-ssh-devtool.pkg for ThinOS 10.x custom package deployment.
# Run on any Linux machine — no special tools required beyond tar + bash.
#
# Output: usb-ssh-devtool_<version>_thinos.pkg
#
# Deploy via:
#   - USB: copy .pkg to USB root; ThinOS installs it on next boot
#   - WMS: upload .pkg to Wyse Management Suite → Apps & Data → App Inventory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="1.0.0"
PKG_NAME="usb-ssh-devtool"
OUTPUT_DIR="$SCRIPT_DIR"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

OUTPUT="${OUTPUT_DIR}/${PKG_NAME}_${VERSION}_thinos.pkg"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

echo "[1/4] Staging package contents ..."
mkdir -p "$STAGE/META" "$STAGE/payload"

# Copy META (manifest + scripts)
cp "$SCRIPT_DIR/META/pkg_manifest.xml" "$STAGE/META/"
cp "$SCRIPT_DIR/META/install.sh"       "$STAGE/META/"
cp "$SCRIPT_DIR/META/uninstall.sh"     "$STAGE/META/"
chmod 755 "$STAGE/META/install.sh" "$STAGE/META/uninstall.sh"

# Copy payload tree
cp -r "$SCRIPT_DIR/payload/." "$STAGE/payload/"
chmod 755 "$STAGE/payload/etc/init.d/ssh-devtool"
chmod 755 "$STAGE/payload/usr/local/bin/"*

echo "[2/4] Writing package signature file ..."
cat > "$STAGE/META/pkg_info" <<EOF
PKG_NAME=$PKG_NAME
PKG_VERSION=$VERSION
PKG_BUILD=$(date +%Y%m%d%H%M%S)
PKG_ARCH=x86_64
PKG_TARGET_OS=ThinOS
PKG_TARGET_VERSION=10.0
PKG_INSTALL_SCRIPT=META/install.sh
PKG_UNINSTALL_SCRIPT=META/uninstall.sh
EOF

echo "[3/4] Packing into .pkg (tar.gz) ..."
# ThinOS custom .pkg = gzip-compressed tar archive
tar -czf "$OUTPUT" -C "$STAGE" \
  --owner=0 --group=0 \
  META/ payload/

chmod 644 "$OUTPUT"

echo "[4/4] Done."
echo ""
echo "┌──────────────────────────────────────────────────────────────────┐"
echo "│  ThinOS 10.x custom .pkg built                                   │"
echo "├──────────────────────────────────────────────────────────────────┤"
printf "│  File    : %-54s│\n" "$(basename "$OUTPUT")"
printf "│  Size    : %-54s│\n" "$(du -sh "$OUTPUT" | cut -f1)"
echo "├──────────────────────────────────────────────────────────────────┤"
echo "│  Deploy options:                                                  │"
echo "│                                                                   │"
echo "│  1. USB install (no network needed):                             │"
echo "│     Copy .pkg to USB root → plug into ThinOS device             │"
echo "│     ThinOS auto-installs on boot                                  │"
echo "│                                                                   │"
echo "│  2. WMS deploy (fleet):                                           │"
echo "│     WMS → Apps & Data → App Inventory → Add                      │"
echo "│     Upload this .pkg → assign to device group                    │"
echo "│                                                                   │"
echo "│  3. Manual install on ThinOS shell:                               │"
printf "│     tar -xzf %-51s│\n" "$(basename "$OUTPUT") -C /tmp/devtool"
echo "│     sh /tmp/devtool/META/install.sh                              │"
echo "└──────────────────────────────────────────────────────────────────┘"

# Verify package integrity
echo ""
echo "Package contents:"
tar -tzf "$OUTPUT" | sed 's/^/  /'

#!/bin/bash
# Builds usb-ssh-devtool.pkg for macOS.
# MUST be run on a Mac — requires Xcode Command Line Tools (pkgbuild, productbuild).
#
# Usage:
#   1. Copy the Ubuntu-generated recovery key to this directory first:
#        cp /Volumes/USB_DATA/devtool/keys/recovery_key ./recovery_key_to_bundle
#   2. Run: ./build_pkg.sh [--version 1.0.0]
#
# The resulting .pkg installs the key + SSH config + connect tool on the Mac.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="1.0.0"
IDENTIFIER="com.homelab.usb-ssh-devtool"
BUILD_TMP="$SCRIPT_DIR/build"
PAYLOAD_ROOT="$SCRIPT_DIR/payload/root"
SCRIPTS_DIR="$SCRIPT_DIR/payload/scripts"
RESOURCES_DIR="$SCRIPT_DIR/resources"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

# ── Require macOS ─────────────────────────────────────────────────────────────
if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: This script must run on macOS (pkgbuild/productbuild required)."
  echo "       On Ubuntu, use the .deb package instead: ../build_deb.sh"
  exit 1
fi

command -v pkgbuild     &>/dev/null || { echo "Install Xcode CLT: xcode-select --install"; exit 1; }
command -v productbuild &>/dev/null || { echo "Install Xcode CLT: xcode-select --install"; exit 1; }

# ── Bundle the private key into payload ───────────────────────────────────────
KEY_SRC="$SCRIPT_DIR/recovery_key_to_bundle"
KEY_DEST="$PAYLOAD_ROOT/usr/local/share/usb-ssh-devtool/recovery_key"

if [[ ! -f "$KEY_SRC" ]]; then
  echo "ERROR: Private key not found at $KEY_SRC"
  echo "       Copy the recovery_key from your Ubuntu machine or USB data partition:"
  echo "         cp /Volumes/USB_DATA/devtool/keys/recovery_key $KEY_SRC"
  exit 1
fi

mkdir -p "$(dirname "$KEY_DEST")"
cp "$KEY_SRC" "$KEY_DEST"
chmod 600 "$KEY_DEST"

# postinstall copies key from /usr/local/share/... to ~/.ssh/
# (payload installs to system paths; postinstall moves it per-user)

# ── Fix script permissions (macOS requires 0755) ──────────────────────────────
chmod 755 "$SCRIPTS_DIR/preinstall"
chmod 755 "$SCRIPTS_DIR/postinstall"
chmod 755 "$PAYLOAD_ROOT/usr/local/bin/"*

# ── Stage: build component .pkg ───────────────────────────────────────────────
mkdir -p "$BUILD_TMP"
COMPONENT_PKG="$BUILD_TMP/usb-ssh-devtool-component.pkg"

pkgbuild \
  --root       "$PAYLOAD_ROOT" \
  --scripts    "$SCRIPTS_DIR" \
  --identifier "$IDENTIFIER" \
  --version    "$VERSION" \
  --install-location "/" \
  "$COMPONENT_PKG"

echo "Component package built: $COMPONENT_PKG"

# ── Synthesize a distribution XML ─────────────────────────────────────────────
DIST_XML="$BUILD_TMP/Distribution.xml"
pkgbuild --analyze --root "$PAYLOAD_ROOT" "$BUILD_TMP/component_info.plist"

productbuild \
  --synthesize \
  --package "$COMPONENT_PKG" \
  "$DIST_XML"

# Inject welcome/conclusion pages into distribution XML
python3 - "$DIST_XML" "$RESOURCES_DIR" <<'PYEOF'
import sys, xml.etree.ElementTree as ET
ET.register_namespace('', '')
tree = ET.parse(sys.argv[1])
root = tree.getroot()
res_dir = sys.argv[2]
for tag, fname in [('welcome','welcome.html'), ('conclusion','conclusion.html')]:
    el = ET.SubElement(root, tag)
    el.set('file', fname)
    el.set('mime-type', 'text/html')
tree.write(sys.argv[1], xml_declaration=True, encoding='utf-8')
PYEOF

# ── Final product .pkg ────────────────────────────────────────────────────────
OUTPUT="$SCRIPT_DIR/usb-ssh-devtool_${VERSION}_macos.pkg"

productbuild \
  --distribution "$DIST_XML" \
  --resources    "$RESOURCES_DIR" \
  --package-path "$BUILD_TMP" \
  "$OUTPUT"

# Clean key from staging area
rm -f "$KEY_DEST"

echo ""
echo "┌────────────────────────────────────────────────────────────────┐"
echo "│  macOS .pkg built successfully                                 │"
echo "├────────────────────────────────────────────────────────────────┤"
printf "│  File  : %-53s│\n" "$(basename "$OUTPUT")"
printf "│  Size  : %-53s│\n" "$(du -sh "$OUTPUT" | cut -f1)"
echo "├────────────────────────────────────────────────────────────────┤"
echo "│  Copy to USB drive alongside the .deb                          │"
echo "│  Double-click to install on any Mac                            │"
echo "└────────────────────────────────────────────────────────────────┘"

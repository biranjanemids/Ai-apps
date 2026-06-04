#!/bin/bash
# Builds the usb-ssh-devtool .deb package.
# Run this on any Ubuntu/Debian machine; no root required.
#
# Usage: ./build_deb.sh [--version 1.0.0]
#
# Output: usb-ssh-devtool_<version>_all.deb  (in this directory)
# Then copy the .deb to your USB drive.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/deb-build"
VERSION="1.0.0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

# Update version in control file
sed -i "s/^Version:.*/Version: $VERSION/" "$BUILD_DIR/DEBIAN/control"

# Calculate installed size (in KB)
INSTALLED_KB=$(du -sk "$BUILD_DIR" | cut -f1)
sed -i "s/^Installed-Size:.*/Installed-Size: $INSTALLED_KB/" "$BUILD_DIR/DEBIAN/control" 2>/dev/null || \
  echo "Installed-Size: $INSTALLED_KB" >> "$BUILD_DIR/DEBIAN/control"

OUTPUT="$SCRIPT_DIR/usb-ssh-devtool_${VERSION}_all.deb"

echo "Building $OUTPUT ..."
dpkg-deb --build --root-owner-group "$BUILD_DIR" "$OUTPUT"

echo ""
echo "┌────────────────────────────────────────────────────────────────┐"
echo "│  Package built successfully                                    │"
echo "├────────────────────────────────────────────────────────────────┤"
printf "│  File    : %-52s│\n" "$(basename "$OUTPUT")"
printf "│  Size    : %-52s│\n" "$(du -sh "$OUTPUT" | cut -f1)"
echo "├────────────────────────────────────────────────────────────────┤"
echo "│  Copy to USB drive, then on the target machine run:            │"
printf "│    sudo dpkg -i %-47s│\n" "$(basename "$OUTPUT")"
echo "│                                                                │"
echo "│  Or double-click the .deb in the file manager (GDebi).        │"
echo "└────────────────────────────────────────────────────────────────┘"
echo ""
echo "  After install, save the private key from the target's Desktop"
echo "  to your USB drive, then connect with:"
echo "    ssh -i usb_devtool_recovery_key devrecovery@<target-ip>"

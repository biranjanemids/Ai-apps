#!/bin/bash
# Prepares a FAT32 USB drive with ThinOS 10.x auto-config for SSH access.
#
# Usage: sudo ./prepare_thinos_usb.sh /dev/sdX
#
# What it does:
#   1. Formats USB as FAT32 (ThinOS requirement)
#   2. Creates \wnos\ folder structure
#   3. Copies wnos.ini and authorized_keys
#   4. Generates an ED25519 keypair if one doesn't exist

set -euo pipefail

USB_DEV="${1:?Usage: $0 /dev/sdX}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)."; exit 1; }

# Safety check — don't wipe internal drives
if [[ "$USB_DEV" == /dev/sda ]] || [[ "$USB_DEV" == /dev/nvme0* ]]; then
  echo "ERROR: '$USB_DEV' looks like an internal drive. Aborting."
  exit 1
fi

read -rp "WARNING: ALL DATA on $USB_DEV will be erased. Continue? [yes/N] " confirm
[[ "$confirm" == "yes" ]] || { echo "Aborted."; exit 0; }

# ── Unmount ───────────────────────────────────────────────────────────────────
for part in "${USB_DEV}"?*; do
  umount "$part" 2>/dev/null || true
done

# ── Format FAT32 (required by ThinOS USB auto-config) ────────────────────────
echo "[1/4] Formatting $USB_DEV as FAT32 ..."
mkfs.vfat -F32 -n "THINOS_CFG" "$USB_DEV"

# ── Mount ─────────────────────────────────────────────────────────────────────
MNT=$(mktemp -d)
mount "$USB_DEV" "$MNT"
trap 'umount "$MNT" 2>/dev/null; rmdir "$MNT" 2>/dev/null' EXIT

# ── Generate keypair if absent ────────────────────────────────────────────────
KEYDIR="$SCRIPT_DIR/keys"
mkdir -p "$KEYDIR"
if [[ ! -f "$KEYDIR/thinos_recovery_key" ]]; then
  echo "[2/4] Generating ED25519 keypair ..."
  ssh-keygen -t ed25519 -C "devtool-thinos-$(date +%Y%m%d)" \
    -N "" -f "$KEYDIR/thinos_recovery_key"
  chmod 600 "$KEYDIR/thinos_recovery_key"
  chmod 644 "$KEYDIR/thinos_recovery_key.pub"
  echo "      Keypair saved to $KEYDIR/"
else
  echo "[2/4] Existing keypair found — reusing."
fi

# ── Inject public key into authorized_keys ───────────────────────────────────
PUBKEY="$(cat "$KEYDIR/thinos_recovery_key.pub")"
sed -i "s|^# ssh-ed25519.*|$PUBKEY|" "$SCRIPT_DIR/wnos/authorized_keys"

# ── Copy wnos config to USB ───────────────────────────────────────────────────
echo "[3/4] Writing ThinOS config to USB ..."
mkdir -p "$MNT/wnos"
cp "$SCRIPT_DIR/wnos/wnos.ini"          "$MNT/wnos/"
cp "$SCRIPT_DIR/wnos/authorized_keys"   "$MNT/wnos/"
# Also copy the public key for reference
cp "$KEYDIR/thinos_recovery_key.pub"    "$MNT/wnos/"

sync
echo "[4/4] Done."

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "┌──────────────────────────────────────────────────────────────────┐"
echo "│  ThinOS USB config ready                                         │"
echo "├──────────────────────────────────────────────────────────────────┤"
echo "│  USB layout:                                                      │"
echo "│    /wnos/wnos.ini          ← ThinOS reads this on boot/insert    │"
echo "│    /wnos/authorized_keys   ← your ED25519 public key             │"
echo "├──────────────────────────────────────────────────────────────────┤"
echo "│  Steps:                                                           │"
echo "│    1. Plug USB into ThinOS 10.x device                           │"
echo "│    2. ThinOS auto-applies config (may reboot)                    │"
echo "│    3. Connect from your workstation:                              │"
printf "│       ssh -i keys/thinos_recovery_key Admin@<thinos-ip>          │\n"
echo "├──────────────────────────────────────────────────────────────────┤"
echo "│  Private key: $KEYDIR/thinos_recovery_key"
echo "│  Keep it secure and copy to your USB drive for portability.      │"
echo "└──────────────────────────────────────────────────────────────────┘"

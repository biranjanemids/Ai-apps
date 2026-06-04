#!/usr/bin/env bash
# Prepares a USB drive with Ubuntu Live ISO + this devtool's recovery payload.
# Run this on any Linux machine BEFORE you need recovery.
#
# Usage: sudo ./1_prepare_usb.sh /dev/sdX [/path/to/ubuntu.iso]
#
# Requirements: dd, sgdisk or fdisk, mkfs.vfat, rsync, syslinux/grub2

set -euo pipefail

USB_DEV="${1:?Usage: $0 /dev/sdX [ubuntu.iso]}"
ISO_PATH="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD_DIR="$(dirname "$SCRIPT_DIR")"   # root of this repo/USB payload

# ── Safety checks ─────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)."; exit 1; }

if [[ "$USB_DEV" == /dev/sd[ab] ]] || [[ "$USB_DEV" == /dev/nvme0* ]]; then
  echo "ERROR: '$USB_DEV' looks like an internal drive. Aborting."
  exit 1
fi

read -rp "WARNING: ALL DATA on $USB_DEV will be erased. Continue? [yes/N] " confirm
[[ "$confirm" == "yes" ]] || { echo "Aborted."; exit 0; }

# ── Unmount any existing partitions ───────────────────────────────────────────
for part in "${USB_DEV}"?*; do
  umount "$part" 2>/dev/null || true
done

# ── Partition: 1 small FAT32 boot, 2 remaining ext4 data ─────────────────────
echo "[1/5] Partitioning $USB_DEV ..."
sgdisk --zap-all "$USB_DEV"
sgdisk \
  --new=1:0:+512M  --typecode=1:ef00 --change-name=1:"USB_BOOT" \
  --new=2:0:0      --typecode=2:8300 --change-name=2:"USB_DATA" \
  "$USB_DEV"
partprobe "$USB_DEV"
sleep 2

BOOT_PART="${USB_DEV}1"
DATA_PART="${USB_DEV}2"

echo "[2/5] Formatting partitions ..."
mkfs.vfat -F32 -n "USB_BOOT" "$BOOT_PART"
mkfs.ext4 -L "USB_DATA"  "$DATA_PART"

# ── Write ISO to boot partition (hybrid ISO method) ───────────────────────────
if [[ -n "$ISO_PATH" && -f "$ISO_PATH" ]]; then
  echo "[3/5] Writing Ubuntu ISO to $BOOT_PART (dd) ..."
  # Use ventoy-style direct ISO copy if available, else dd to whole device
  if command -v ventoy &>/dev/null; then
    ventoy -i "$USB_DEV"
    cp "$ISO_PATH" /mnt/ventoy/ 2>/dev/null || true
  else
    # Direct dd to the boot partition — works for hybrid ISOs
    dd if="$ISO_PATH" of="$BOOT_PART" bs=4M status=progress conv=fsync
  fi
else
  echo "[3/5] No ISO provided — skipping (boot partition formatted only)."
  echo "      Download Ubuntu Live ISO and write it manually, or re-run with ISO path."
fi

# ── Copy devtool payload to data partition ────────────────────────────────────
echo "[4/5] Copying recovery payload to $DATA_PART ..."
MNT_DATA=$(mktemp -d)
mount "$DATA_PART" "$MNT_DATA"
rsync -a --info=progress2 "$PAYLOAD_DIR/" "$MNT_DATA/devtool/"
# Generate a new ED25519 key pair for this USB if not already present
KEY_DIR="$MNT_DATA/devtool/keys"
mkdir -p "$KEY_DIR"
if [[ ! -f "$KEY_DIR/recovery_key" ]]; then
  ssh-keygen -t ed25519 -C "usb-recovery-$(date +%Y%m%d)" -N "" -f "$KEY_DIR/recovery_key"
  echo "Recovery keypair generated: $KEY_DIR/recovery_key"
fi
chmod 600 "$KEY_DIR/recovery_key"
chmod 644 "$KEY_DIR/recovery_key.pub"
umount "$MNT_DATA"
rmdir "$MNT_DATA"

echo "[5/5] Done."
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  USB is ready.                                           ║"
echo "║  Recovery public key:                                    ║"
cat "$PAYLOAD_DIR/keys/recovery_key.pub" 2>/dev/null || \
  echo "  (key is on the USB data partition — mount to view)"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Next: boot the target machine from this USB, then run:"
echo "  sudo /mnt/usb_data/devtool/scripts/2_recover_ssh.sh"

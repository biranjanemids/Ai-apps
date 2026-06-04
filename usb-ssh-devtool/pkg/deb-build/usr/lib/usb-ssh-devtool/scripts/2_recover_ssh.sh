#!/usr/bin/env bash
# Run from a LIVE Ubuntu USB environment (not the target system).
# Finds the target Ubuntu install, chroots into it, and enables SSH with
# key-based auth. Handles: disabled sshd, UFW rules, AppArmor, fail2ban.
#
# Usage: sudo ./2_recover_ssh.sh [--target-disk /dev/sdaX] [--port 2222]
#
# The recovery SSH public key must sit next to this script at ../keys/recovery_key.pub

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVTOOL_DIR="$(dirname "$SCRIPT_DIR")"
PUBKEY_FILE="$DEVTOOL_DIR/keys/recovery_key.pub"
SSH_PORT=22
TARGET_DISK=""
RECOVERY_USER="devrecovery"

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-disk) TARGET_DISK="$2"; shift 2 ;;
    --port)        SSH_PORT="$2";    shift 2 ;;
    --user)        RECOVERY_USER="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)."; exit 1; }
[[ -f "$PUBKEY_FILE" ]] || { echo "ERROR: Public key not found at $PUBKEY_FILE"; exit 1; }

PUBKEY="$(cat "$PUBKEY_FILE")"

# ── Auto-detect target partition if not specified ─────────────────────────────
detect_ubuntu_partition() {
  for dev in $(lsblk -lno NAME,TYPE | awk '$2=="part"{print $1}'); do
    local mnt
    mnt=$(mktemp -d)
    if mount "/dev/$dev" "$mnt" 2>/dev/null; then
      if [[ -f "$mnt/etc/os-release" ]] && grep -qi ubuntu "$mnt/etc/os-release" 2>/dev/null; then
        umount "$mnt"
        rmdir "$mnt"
        echo "/dev/$dev"
        return 0
      fi
      umount "$mnt"
    fi
    rmdir "$mnt" 2>/dev/null || true
  done
  return 1
}

if [[ -z "$TARGET_DISK" ]]; then
  echo "[auto-detect] Searching for Ubuntu partition ..."
  TARGET_DISK="$(detect_ubuntu_partition)" || {
    echo "ERROR: Could not auto-detect Ubuntu partition."
    echo "List partitions with: lsblk -o NAME,FSTYPE,SIZE,LABEL,MOUNTPOINT"
    echo "Then re-run with: --target-disk /dev/sdaX"
    exit 1
  }
  echo "[auto-detect] Found: $TARGET_DISK"
fi

# ── Mount target system ───────────────────────────────────────────────────────
TARGET_MNT=$(mktemp -d)
echo "[1/7] Mounting $TARGET_DISK at $TARGET_MNT ..."
mount "$TARGET_DISK" "$TARGET_MNT"

# Mount critical pseudo-filesystems for chroot
for fs in proc sys dev dev/pts run; do
  mkdir -p "$TARGET_MNT/$fs"
done
mount --bind /proc    "$TARGET_MNT/proc"
mount --bind /sys     "$TARGET_MNT/sys"
mount --bind /dev     "$TARGET_MNT/dev"
mount --bind /dev/pts "$TARGET_MNT/dev/pts"
mount --bind /run     "$TARGET_MNT/run"

cleanup() {
  echo "Cleaning up mounts ..."
  for fs in dev/pts dev proc sys run; do
    umount "$TARGET_MNT/$fs" 2>/dev/null || true
  done
  umount "$TARGET_MNT" 2>/dev/null || true
  rmdir  "$TARGET_MNT" 2>/dev/null || true
}
trap cleanup EXIT

# ── Create or update recovery user ───────────────────────────────────────────
echo "[2/7] Setting up recovery user '$RECOVERY_USER' in chroot ..."
chroot "$TARGET_MNT" /bin/bash -s -- "$RECOVERY_USER" "$PUBKEY" "$SSH_PORT" <<'CHROOT'
set -euo pipefail
RECOVERY_USER="$1"
PUBKEY="$2"
SSH_PORT="$3"

# Create user if absent; add to sudo group
if ! id "$RECOVERY_USER" &>/dev/null; then
  useradd -m -s /bin/bash -G sudo "$RECOVERY_USER"
  echo "$RECOVERY_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$RECOVERY_USER"
  chmod 440 "/etc/sudoers.d/90-$RECOVERY_USER"
fi

# Install public key
SSH_DIR="/home/$RECOVERY_USER/.ssh"
mkdir -p "$SSH_DIR"
AUTH_KEYS="$SSH_DIR/authorized_keys"
# Add key only if not already present
if ! grep -qF "$PUBKEY" "$AUTH_KEYS" 2>/dev/null; then
  echo "$PUBKEY" >> "$AUTH_KEYS"
fi
chmod 700 "$SSH_DIR"
chmod 600 "$AUTH_KEYS"
chown -R "$RECOVERY_USER:$RECOVERY_USER" "$SSH_DIR"
CHROOT

# ── Patch sshd_config ─────────────────────────────────────────────────────────
echo "[3/7] Patching /etc/ssh/sshd_config ..."
SSHD_CONF="$TARGET_MNT/etc/ssh/sshd_config"

patch_or_append() {
  local key="$1" val="$2" file="$3"
  if grep -qE "^#?[[:space:]]*${key}" "$file"; then
    sed -i -E "s|^#?[[:space:]]*${key}.*|${key} ${val}|" "$file"
  else
    echo "${key} ${val}" >> "$file"
  fi
}

patch_or_append "Port"                    "$SSH_PORT"  "$SSHD_CONF"
patch_or_append "PermitRootLogin"         "no"         "$SSHD_CONF"
patch_or_append "PubkeyAuthentication"    "yes"        "$SSHD_CONF"
patch_or_append "PasswordAuthentication"  "no"         "$SSHD_CONF"
patch_or_append "AuthorizedKeysFile"      ".ssh/authorized_keys" "$SSHD_CONF"
patch_or_append "ChallengeResponseAuthentication" "no" "$SSHD_CONF"
# Allow our recovery user explicitly
if ! grep -q "AllowUsers.*$RECOVERY_USER" "$SSHD_CONF"; then
  # Preserve existing AllowUsers if present, else add
  if grep -qE "^AllowUsers" "$SSHD_CONF"; then
    sed -i -E "s|^(AllowUsers.*)|\1 $RECOVERY_USER|" "$SSHD_CONF"
  else
    echo "AllowUsers $RECOVERY_USER" >> "$SSHD_CONF"
  fi
fi

# ── Enable and start sshd in target ───────────────────────────────────────────
echo "[4/7] Enabling sshd service ..."
chroot "$TARGET_MNT" systemctl enable ssh 2>/dev/null || \
chroot "$TARGET_MNT" systemctl enable sshd 2>/dev/null || \
  echo "  (systemctl not functional in chroot — service will start on next boot)"

# ── UFW: open SSH port ─────────────────────────────────────────────────────────
echo "[5/7] Configuring UFW firewall ..."
if [[ -f "$TARGET_MNT/usr/sbin/ufw" ]]; then
  chroot "$TARGET_MNT" /bin/bash -c "
    ufw allow $SSH_PORT/tcp comment 'USB devtool SSH recovery' 2>/dev/null || true
    ufw --force enable 2>/dev/null || true
  " || echo "  UFW config attempted (may need reboot to take effect)"
else
  echo "  UFW not found — skipping"
fi

# If iptables rules exist that block SSH, insert an ACCEPT before them
if chroot "$TARGET_MNT" iptables -L INPUT -n 2>/dev/null | grep -q "DROP\|REJECT"; then
  echo "  Detected iptables DROP/REJECT — inserting ACCEPT for port $SSH_PORT ..."
  chroot "$TARGET_MNT" iptables -I INPUT 1 -p tcp --dport "$SSH_PORT" -j ACCEPT 2>/dev/null || true
  # Persist iptables rules
  chroot "$TARGET_MNT" sh -c "iptables-save > /etc/iptables/rules.v4" 2>/dev/null || true
fi

# ── Disable fail2ban for SSH (temporary) ─────────────────────────────────────
echo "[6/7] Checking fail2ban ..."
if [[ -f "$TARGET_MNT/etc/fail2ban/jail.local" ]]; then
  # Add ignoreip for all RFC1918 addresses so you can connect from LAN
  if ! grep -q "ignoreip" "$TARGET_MNT/etc/fail2ban/jail.local"; then
    sed -i '/^\[DEFAULT\]/a ignoreip = 127.0.0.1/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16' \
      "$TARGET_MNT/etc/fail2ban/jail.local"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
TARGET_IP=$(chroot "$TARGET_MNT" hostname -I 2>/dev/null | awk '{print $1}' || echo "<unknown — check after reboot>")
echo "[7/7] Done."
echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║  SSH Recovery configured successfully                            ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
printf  "║  Target partition : %-44s║\n" "$TARGET_DISK"
printf  "║  Recovery user    : %-44s║\n" "$RECOVERY_USER"
printf  "║  SSH port         : %-44s║\n" "$SSH_PORT"
printf  "║  Target IP (est.) : %-44s║\n" "$TARGET_IP"
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  After rebooting into the installed system, connect with:        ║"
printf  "║    ssh -i keys/recovery_key -p %s %s@%s\n" "$SSH_PORT" "$RECOVERY_USER" "$TARGET_IP"
echo "║                                                                  ║"
echo "║  Remove the recovery user when done:                             ║"
printf  "║    sudo userdel -r %s\n" "$RECOVERY_USER"
echo "╚══════════════════════════════════════════════════════════════════╝"

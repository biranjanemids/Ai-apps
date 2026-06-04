#!/usr/bin/env bash
# Run DIRECTLY on the target Ubuntu system (not from live USB).
# Use this when you have any shell access (physical, serial console, VNC, etc.)
# and want to install the SSH devtool agent on the running system.
#
# Usage: sudo ./3_install_agent.sh [--port 2222] [--user devrecovery]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVTOOL_DIR="$(dirname "$SCRIPT_DIR")"
PUBKEY_FILE="$DEVTOOL_DIR/keys/recovery_key.pub"
SSH_PORT=22
RECOVERY_USER="devrecovery"
SERVICE_NAME="ssh-devtool-watchdog"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) SSH_PORT="$2"; shift 2 ;;
    --user) RECOVERY_USER="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Run as root."; exit 1; }
[[ -f "$PUBKEY_FILE" ]] || { echo "ERROR: $PUBKEY_FILE not found."; exit 1; }

PUBKEY="$(cat "$PUBKEY_FILE")"

echo "[1/6] Installing openssh-server if absent ..."
if ! dpkg -l openssh-server &>/dev/null; then
  apt-get update -qq
  apt-get install -y openssh-server
fi

echo "[2/6] Creating user '$RECOVERY_USER' ..."
if ! id "$RECOVERY_USER" &>/dev/null; then
  useradd -m -s /bin/bash -G sudo "$RECOVERY_USER"
fi
# Lock password (key-only auth)
passwd -l "$RECOVERY_USER"
echo "$RECOVERY_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$RECOVERY_USER"
chmod 440 "/etc/sudoers.d/90-$RECOVERY_USER"

SSH_DIR="/home/$RECOVERY_USER/.ssh"
mkdir -p "$SSH_DIR"
if ! grep -qF "$PUBKEY" "$SSH_DIR/authorized_keys" 2>/dev/null; then
  echo "$PUBKEY" >> "$SSH_DIR/authorized_keys"
fi
chmod 700 "$SSH_DIR"
chmod 600 "$SSH_DIR/authorized_keys"
chown -R "$RECOVERY_USER:$RECOVERY_USER" "$SSH_DIR"

echo "[3/6] Patching sshd_config ..."
SSHD_CONF=/etc/ssh/sshd_config
patch_or_append() {
  local key="$1" val="$2"
  if grep -qE "^#?[[:space:]]*${key}" "$SSHD_CONF"; then
    sed -i -E "s|^#?[[:space:]]*${key}.*|${key} ${val}|" "$SSHD_CONF"
  else
    echo "${key} ${val}" >> "$SSHD_CONF"
  fi
}
patch_or_append "Port"                    "$SSH_PORT"
patch_or_append "PubkeyAuthentication"    "yes"
patch_or_append "PasswordAuthentication"  "no"
patch_or_append "PermitRootLogin"         "no"
patch_or_append "AuthorizedKeysFile"      ".ssh/authorized_keys"

if ! grep -qE "^AllowUsers.*$RECOVERY_USER" "$SSHD_CONF"; then
  if grep -qE "^AllowUsers" "$SSHD_CONF"; then
    sed -i -E "s|^(AllowUsers.*)|\1 $RECOVERY_USER|" "$SSHD_CONF"
  else
    echo "AllowUsers $RECOVERY_USER" >> "$SSHD_CONF"
  fi
fi

echo "[4/6] Opening firewall port $SSH_PORT ..."
if command -v ufw &>/dev/null; then
  ufw allow "$SSH_PORT"/tcp comment "usb-devtool" || true
  ufw --force enable || true
elif command -v firewall-cmd &>/dev/null; then
  firewall-cmd --permanent --add-port="${SSH_PORT}/tcp"
  firewall-cmd --reload
fi

echo "[5/6] Enabling and restarting sshd ..."
systemctl enable ssh  2>/dev/null || systemctl enable sshd
systemctl restart ssh 2>/dev/null || systemctl restart sshd

# ── Install watchdog service (keeps SSH alive even if config is reverted) ────
echo "[6/6] Installing watchdog systemd service ..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=USB Devtool SSH Watchdog
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c 'systemctl is-active ssh || systemctl restart ssh'
ExecStartPost=/bin/bash -c 'ufw allow ${SSH_PORT}/tcp 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
EOF

cat > "/etc/systemd/system/${SERVICE_NAME}.timer" <<EOF
[Unit]
Description=Run SSH Watchdog every 5 minutes

[Timer]
OnBootSec=60
OnUnitActiveSec=5min
Unit=${SERVICE_NAME}.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.timer"
systemctl start  "${SERVICE_NAME}.timer"

# ── Done ─────────────────────────────────────────────────────────────────────
MY_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║  SSH Devtool Agent installed successfully                        ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
printf  "║  User : %-55s║\n" "$RECOVERY_USER"
printf  "║  Port : %-55s║\n" "$SSH_PORT"
printf  "║  IP   : %-55s║\n" "$MY_IP"
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  Connect from your workstation:                                  ║"
printf  "║    ssh -i /path/to/recovery_key -p %s %s@%s\n" "$SSH_PORT" "$RECOVERY_USER" "$MY_IP"
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  CLEANUP when done — run on this machine:                        ║"
printf  "║    sudo ./scripts/4_cleanup.sh\n"
echo "╚══════════════════════════════════════════════════════════════════╝"

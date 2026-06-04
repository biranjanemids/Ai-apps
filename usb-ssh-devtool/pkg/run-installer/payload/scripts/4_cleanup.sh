#!/usr/bin/env bash
# Removes the recovery user, watchdog service, and reverts SSH config changes.
# Run on the target machine once you no longer need recovery access.
#
# Usage: sudo ./4_cleanup.sh [--user devrecovery] [--port 22]

set -euo pipefail

RECOVERY_USER="devrecovery"
SSH_PORT=22
SERVICE_NAME="ssh-devtool-watchdog"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) RECOVERY_USER="$2"; shift 2 ;;
    --port) SSH_PORT="$2";      shift 2 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Run as root."; exit 1; }

read -rp "This will remove user '$RECOVERY_USER' and the watchdog service. Continue? [yes/N] " c
[[ "$c" == "yes" ]] || { echo "Aborted."; exit 0; }

echo "Stopping watchdog ..."
systemctl stop  "${SERVICE_NAME}.timer"  2>/dev/null || true
systemctl stop  "${SERVICE_NAME}.service" 2>/dev/null || true
systemctl disable "${SERVICE_NAME}.timer" 2>/dev/null || true
rm -f "/etc/systemd/system/${SERVICE_NAME}.service" \
      "/etc/systemd/system/${SERVICE_NAME}.timer"
systemctl daemon-reload

echo "Removing user '$RECOVERY_USER' ..."
userdel -r "$RECOVERY_USER" 2>/dev/null || true
rm -f "/etc/sudoers.d/90-$RECOVERY_USER"

echo "Removing AllowUsers entry from sshd_config ..."
sed -i -E "s/[[:space:]]*${RECOVERY_USER}//g" /etc/ssh/sshd_config
# Clean up empty AllowUsers line
sed -i -E '/^AllowUsers[[:space:]]*$/d' /etc/ssh/sshd_config

echo "Closing firewall port $SSH_PORT ..."
if command -v ufw &>/dev/null; then
  ufw delete allow "${SSH_PORT}/tcp" 2>/dev/null || true
fi

echo "Restarting sshd ..."
systemctl restart ssh 2>/dev/null || systemctl restart sshd

echo "Done. Recovery access removed."

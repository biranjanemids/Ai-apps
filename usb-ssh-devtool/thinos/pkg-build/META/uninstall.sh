#!/bin/sh
# ThinOS 10.x uninstall script for USB SSH Devtool.

SSH_CONF="/etc/ssh/sshd_config"
KEY_DIR="/etc/ssh/devtool_keys"
LOG="/var/log/usb-ssh-devtool-install.log"

log() { echo "[usb-ssh-devtool] $*" | tee -a "$LOG"; }

log "Uninstalling USB SSH Devtool ..."

# Stop and disable service
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop    ssh-devtool 2>/dev/null || true
  systemctl disable ssh-devtool 2>/dev/null || true
elif [ -x /etc/init.d/ssh-devtool ]; then
  /etc/init.d/ssh-devtool stop 2>/dev/null || true
  update-rc.d ssh-devtool remove 2>/dev/null || true
fi

# Restore original sshd_config
if [ -f "${SSH_CONF}.orig" ]; then
  cp "${SSH_CONF}.orig" "$SSH_CONF"
  log "Restored original sshd_config."
else
  # Remove devtool block from sshd_config
  sed -i '/# --- usb-ssh-devtool ---/,/# --- end usb-ssh-devtool ---/d' "$SSH_CONF" 2>/dev/null || true
fi

# Remove authorized keys
for ADMIN_HOME in /root /home/Admin /home/admin; do
  AUTH_KEYS="$ADMIN_HOME/.ssh/authorized_keys"
  if [ -f "$AUTH_KEYS" ] && [ -f "$KEY_DIR/recovery_key.pub" ]; then
    PUBKEY="$(cat "$KEY_DIR/recovery_key.pub")"
    grep -v "$PUBKEY" "$AUTH_KEYS" > "${AUTH_KEYS}.tmp" && mv "${AUTH_KEYS}.tmp" "$AUTH_KEYS"
  fi
done

# Remove key directory
rm -rf "$KEY_DIR"
rm -f /wnos/devtool_recovery_key.pub

# Remove payload files
rm -f /usr/local/bin/devtool-status
rm -f /usr/local/bin/devtool-cleanup
rm -f /etc/init.d/ssh-devtool
rm -f /etc/ssh/sshd_config.devtool

# Restart SSH with restored config
if command -v systemctl >/dev/null 2>&1; then
  systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true
fi

log "Uninstall complete."
exit 0

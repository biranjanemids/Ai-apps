#!/bin/sh
# ThinOS 10.x custom package install script for USB SSH Devtool.
# Called by ThinOS package manager after payload files are extracted.
# Runs as root in ThinOS busybox shell (sh, not bash).

PKG_DIR="/pkg/usb-ssh-devtool"
SSH_CONF="/etc/ssh/sshd_config"
KEY_DIR="/etc/ssh/devtool_keys"
AUTHORIZED_KEYS_DIR="/etc/ssh/devtool_authorized"
RECOVERY_USER="Admin"
LOG="/var/log/usb-ssh-devtool-install.log"

log() { echo "[usb-ssh-devtool] $*" | tee -a "$LOG"; }

log "Starting installation v1.0.0 ..."

# ── Create key directory ──────────────────────────────────────────────────────
mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"
mkdir -p "$AUTHORIZED_KEYS_DIR"

# ── Generate ED25519 keypair if absent ────────────────────────────────────────
if [ ! -f "$KEY_DIR/recovery_key" ]; then
  log "Generating ED25519 keypair ..."
  if command -v ssh-keygen >/dev/null 2>&1; then
    ssh-keygen -t ed25519 -C "devtool-thinos" -N "" -f "$KEY_DIR/recovery_key"
    chmod 600 "$KEY_DIR/recovery_key"
    chmod 644 "$KEY_DIR/recovery_key.pub"
    log "Keypair generated at $KEY_DIR/recovery_key"
  else
    log "WARN: ssh-keygen not available — place public key manually at $AUTHORIZED_KEYS_DIR/authorized_keys"
  fi
fi

# ── Install authorized_keys for Admin user ────────────────────────────────────
# ThinOS Admin home is typically /root or /home/Admin
for ADMIN_HOME in /root /home/Admin /home/admin; do
  if [ -d "$ADMIN_HOME" ]; then
    mkdir -p "$ADMIN_HOME/.ssh"
    chmod 700 "$ADMIN_HOME/.ssh"
    AUTH_KEYS="$ADMIN_HOME/.ssh/authorized_keys"
    if [ -f "$KEY_DIR/recovery_key.pub" ]; then
      PUBKEY="$(cat "$KEY_DIR/recovery_key.pub")"
      grep -qF "$PUBKEY" "$AUTH_KEYS" 2>/dev/null || echo "$PUBKEY" >> "$AUTH_KEYS"
      chmod 600 "$AUTH_KEYS"
      log "Public key installed to $AUTH_KEYS"
    fi
    break
  fi
done

# ── Patch sshd_config ─────────────────────────────────────────────────────────
log "Patching $SSH_CONF ..."
if [ -f "$SSH_CONF" ]; then
  # Back up original
  [ -f "${SSH_CONF}.orig" ] || cp "$SSH_CONF" "${SSH_CONF}.orig"

  # Apply devtool sshd settings using sed (busybox compatible)
  # Enable SSH server
  sed -i 's/^#*[[:space:]]*Port .*/Port 22/'                           "$SSH_CONF" 2>/dev/null || true
  sed -i 's/^#*[[:space:]]*PubkeyAuthentication .*/PubkeyAuthentication yes/' "$SSH_CONF" 2>/dev/null || true
  sed -i 's/^#*[[:space:]]*PasswordAuthentication .*/PasswordAuthentication no/' "$SSH_CONF" 2>/dev/null || true
  sed -i 's/^#*[[:space:]]*PermitRootLogin .*/PermitRootLogin yes/'    "$SSH_CONF" 2>/dev/null || true
  sed -i 's/^#*[[:space:]]*AuthorizedKeysFile .*/AuthorizedKeysFile .ssh\/authorized_keys/' "$SSH_CONF" 2>/dev/null || true

  # Append devtool config block if not already present
  if ! grep -q "usb-ssh-devtool" "$SSH_CONF" 2>/dev/null; then
    cat >> "$SSH_CONF" <<EOF

# --- usb-ssh-devtool ---
PubkeyAuthentication yes
PasswordAuthentication no
AuthorizedKeysFile .ssh/authorized_keys
MaxAuthTries 3
LoginGraceTime 30
# --- end usb-ssh-devtool ---
EOF
  fi
  log "sshd_config patched."
fi

# ── Enable and start SSH service ──────────────────────────────────────────────
log "Enabling SSH service ..."

# ThinOS 10.x uses either systemd or an init.d style depending on build
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable ssh  2>/dev/null || systemctl enable sshd  2>/dev/null || true
  systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true
  log "SSH started via systemctl."
elif [ -x /etc/init.d/ssh ]; then
  /etc/init.d/ssh restart
  log "SSH restarted via init.d."
elif [ -x /etc/init.d/sshd ]; then
  /etc/init.d/sshd restart
  log "SSH restarted via init.d/sshd."
else
  # Fallback: start sshd directly (ThinOS may have it in /usr/sbin)
  for sshd_bin in /usr/sbin/sshd /sbin/sshd /usr/bin/sshd; do
    if [ -x "$sshd_bin" ]; then
      "$sshd_bin" -f "$SSH_CONF" &
      log "sshd started directly from $sshd_bin."
      break
    fi
  done
fi

# ── Install init.d service for persistence across reboots ────────────────────
if [ -f /etc/init.d/ssh-devtool ]; then
  chmod +x /etc/init.d/ssh-devtool
  if command -v update-rc.d >/dev/null 2>&1; then
    update-rc.d ssh-devtool defaults 2>/dev/null || true
  elif command -v rc-update >/dev/null 2>&1; then
    rc-update add ssh-devtool default 2>/dev/null || true
  fi
  log "ssh-devtool service registered."
fi

# ── Write wnos.ini SSH block for ThinOS native config ─────────────────────────
WNOS_CONF="/wnos/wnos.ini"
if [ -f "$WNOS_CONF" ]; then
  if ! grep -q "SSHServer=yes" "$WNOS_CONF" 2>/dev/null; then
    echo "" >> "$WNOS_CONF"
    echo "# usb-ssh-devtool" >> "$WNOS_CONF"
    echo "SSHServer=yes"      >> "$WNOS_CONF"
    echo "SSHPort=22"         >> "$WNOS_CONF"
    echo "SSHPasswordAuth=no" >> "$WNOS_CONF"
    log "wnos.ini updated with SSHServer=yes."
  fi
fi

# ── Copy public key to /wnos for easy USB export ─────────────────────────────
if [ -f "$KEY_DIR/recovery_key.pub" ]; then
  cp "$KEY_DIR/recovery_key.pub" /wnos/devtool_recovery_key.pub 2>/dev/null || true
  log "Public key copied to /wnos/devtool_recovery_key.pub"
fi

MY_IP=$(ip addr show | grep 'inet ' | grep -v '127.0.0.1' | awk '{print $2}' | cut -d/ -f1 | head -1)

log "Installation complete."
log "Connect: ssh -i $KEY_DIR/recovery_key Admin@${MY_IP:-<device-ip>}"
log "Run 'devtool-status' to check SSH state."

exit 0

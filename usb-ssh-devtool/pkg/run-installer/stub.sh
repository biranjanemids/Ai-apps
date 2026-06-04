#!/bin/bash
# USB SSH Devtool — self-extracting installer for Ubuntu
# Single-file, no dependencies beyond bash + openssh-server.
#
# Usage:
#   sudo ./usb-ssh-devtool.pkg              # install with defaults
#   sudo ./usb-ssh-devtool.pkg --port 2222  # custom SSH port
#   sudo ./usb-ssh-devtool.pkg --user myuser
#   sudo ./usb-ssh-devtool.pkg --uninstall
#
# This file is self-contained: the payload is base64-encoded below the
# __PAYLOAD__ marker and extracted at runtime — no internet required.

set -euo pipefail

VERSION="1.0.0"
SSH_PORT=22
RECOVERY_USER="devrecovery"
UNINSTALL=false
INSTALL_DIR="/opt/usb-ssh-devtool"
SERVICE_NAME="usb-ssh-devtool-watchdog"

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}[info]${NC}  $*"; }
success() { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC}  $*"; }
die()     { echo -e "${RED}[error]${NC} $*" >&2; exit 1; }

# ── Banner ────────────────────────────────────────────────────────────────────
echo -e "${BOLD}"
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║      USB SSH Devtool  v${VERSION}               ║"
echo "  ║      Ubuntu Self-Extracting Installer        ║"
echo "  ╚══════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)        SSH_PORT="$2";       shift 2 ;;
    --user)        RECOVERY_USER="$2";  shift 2 ;;
    --uninstall)   UNINSTALL=true;      shift   ;;
    --help|-h)
      echo "Usage: sudo $0 [--port PORT] [--user USER] [--uninstall]"
      exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Run as root:  sudo $0"

# ── Uninstall path ─────────────────────────────────────────────────────────────
if $UNINSTALL; then
  info "Uninstalling USB SSH Devtool ..."
  systemctl stop    "${SERVICE_NAME}.timer"   2>/dev/null || true
  systemctl disable "${SERVICE_NAME}.timer"   2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service" \
        "/etc/systemd/system/${SERVICE_NAME}.timer"
  systemctl daemon-reload

  userdel -r "$RECOVERY_USER" 2>/dev/null && success "User '$RECOVERY_USER' removed." \
    || warn "User '$RECOVERY_USER' not found."
  rm -f "/etc/sudoers.d/90-usb-ssh-devtool"

  sed -i -E "s/[[:space:]]*${RECOVERY_USER}//g" /etc/ssh/sshd_config 2>/dev/null || true
  sed -i -E '/^AllowUsers[[:space:]]*$/d'        /etc/ssh/sshd_config 2>/dev/null || true

  if command -v ufw &>/dev/null; then
    ufw delete allow "${SSH_PORT}/tcp" 2>/dev/null && success "UFW rule removed." || true
  fi

  rm -rf "$INSTALL_DIR"
  systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true
  success "Uninstall complete."
  exit 0
fi

# ── Extract payload ───────────────────────────────────────────────────────────
TMPDIR_EXTRACT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_EXTRACT"' EXIT

info "Extracting payload ..."
PAYLOAD_LINE=$(grep -n "^__PAYLOAD__$" "$0" | cut -d: -f1)
tail -n +"$((PAYLOAD_LINE + 1))" "$0" | base64 -d | tar -xz -C "$TMPDIR_EXTRACT"
success "Payload extracted."

# ── Install files ──────────────────────────────────────────────────────────────
info "Installing to $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"/{keys,scripts,config}
cp -r "$TMPDIR_EXTRACT"/scripts/* "$INSTALL_DIR/scripts/"
cp -r "$TMPDIR_EXTRACT"/config/*  "$INSTALL_DIR/config/"
chmod 755 "$INSTALL_DIR/scripts/"*.sh
chmod 700 "$INSTALL_DIR/keys"

# Install CLI commands
cp "$TMPDIR_EXTRACT/bin/usb-ssh-devtool-status"  /usr/local/bin/
cp "$TMPDIR_EXTRACT/bin/usb-ssh-devtool-cleanup" /usr/local/bin/
chmod 755 /usr/local/bin/usb-ssh-devtool-{status,cleanup}

# Install systemd units
cp "$TMPDIR_EXTRACT/systemd/${SERVICE_NAME}.service" /etc/systemd/system/
cp "$TMPDIR_EXTRACT/systemd/${SERVICE_NAME}.timer"   /etc/systemd/system/
success "Files installed."

# ── Install openssh-server if absent ──────────────────────────────────────────
if ! dpkg -l openssh-server 2>/dev/null | grep -q "^ii"; then
  info "Installing openssh-server ..."
  apt-get update -qq && apt-get install -y openssh-server
  success "openssh-server installed."
fi

# ── Generate keypair ──────────────────────────────────────────────────────────
KEYFILE="$INSTALL_DIR/keys/recovery_key"
if [[ ! -f "$KEYFILE" ]]; then
  info "Generating ED25519 keypair ..."
  ssh-keygen -t ed25519 -C "usb-devtool-$(hostname)-$(date +%Y%m%d)" \
    -N "" -f "$KEYFILE"
  chmod 600 "$KEYFILE"
  chmod 644 "${KEYFILE}.pub"
  success "Keypair generated: $KEYFILE"
else
  warn "Existing keypair found — reusing."
fi
PUBKEY="$(cat "${KEYFILE}.pub")"

# ── Create recovery user ──────────────────────────────────────────────────────
info "Setting up user '$RECOVERY_USER' ..."
if ! id "$RECOVERY_USER" &>/dev/null; then
  useradd -m -s /bin/bash -G sudo "$RECOVERY_USER"
fi
passwd -l "$RECOVERY_USER"
echo "$RECOVERY_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-usb-ssh-devtool"
chmod 440 "/etc/sudoers.d/90-usb-ssh-devtool"

SSH_DIR="/home/$RECOVERY_USER/.ssh"
mkdir -p "$SSH_DIR"
AUTH_KEYS="$SSH_DIR/authorized_keys"
grep -qF "$PUBKEY" "$AUTH_KEYS" 2>/dev/null || echo "$PUBKEY" >> "$AUTH_KEYS"
chmod 700 "$SSH_DIR"
chmod 600 "$AUTH_KEYS"
chown -R "$RECOVERY_USER:$RECOVERY_USER" "$SSH_DIR"
success "User '$RECOVERY_USER' configured."

# ── Patch sshd_config ─────────────────────────────────────────────────────────
info "Patching /etc/ssh/sshd_config ..."
SSHD_CONF=/etc/ssh/sshd_config
patch_sshd() {
  local key="$1" val="$2"
  if grep -qE "^#?[[:space:]]*${key}[[:space:]]" "$SSHD_CONF"; then
    sed -i -E "s|^#?[[:space:]]*${key}[[:space:]].*|${key} ${val}|" "$SSHD_CONF"
  else
    echo "${key} ${val}" >> "$SSHD_CONF"
  fi
}
patch_sshd Port                           "$SSH_PORT"
patch_sshd PubkeyAuthentication           yes
patch_sshd PasswordAuthentication         no
patch_sshd PermitRootLogin                no
patch_sshd ChallengeResponseAuthentication no
patch_sshd AuthorizedKeysFile             ".ssh/authorized_keys"

if ! grep -qE "^AllowUsers.*$RECOVERY_USER" "$SSHD_CONF"; then
  grep -qE "^AllowUsers" "$SSHD_CONF" \
    && sed -i -E "s|^(AllowUsers.*)|\1 $RECOVERY_USER|" "$SSHD_CONF" \
    || echo "AllowUsers $RECOVERY_USER" >> "$SSHD_CONF"
fi
success "sshd_config patched."

# ── Firewall ──────────────────────────────────────────────────────────────────
info "Opening firewall port $SSH_PORT ..."
if command -v ufw &>/dev/null; then
  ufw allow "${SSH_PORT}/tcp" comment "usb-ssh-devtool" 2>/dev/null || true
  ufw --force enable 2>/dev/null || true
  success "UFW rule added."
else
  warn "UFW not found — skipping firewall config."
fi

# ── Enable sshd ───────────────────────────────────────────────────────────────
info "Enabling sshd ..."
systemctl enable ssh  2>/dev/null || systemctl enable sshd  2>/dev/null || true
systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true
success "sshd running."

# ── Watchdog timer ────────────────────────────────────────────────────────────
info "Enabling watchdog timer ..."
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.timer"
systemctl start  "${SERVICE_NAME}.timer"
success "Watchdog active."

# ── Copy key to Desktop ───────────────────────────────────────────────────────
REAL_USER="${SUDO_USER:-$(logname 2>/dev/null || echo "")}"
if [[ -n "$REAL_USER" ]]; then
  DESKTOP="/home/$REAL_USER/Desktop"
  if [[ -d "$DESKTOP" ]]; then
    cp "$KEYFILE" "$DESKTOP/usb_devtool_recovery_key"
    chown "$REAL_USER:" "$DESKTOP/usb_devtool_recovery_key"
    chmod 600 "$DESKTOP/usb_devtool_recovery_key"
    success "Private key copied to Desktop — save it to your USB!"
  fi
fi

# ── Write config file ─────────────────────────────────────────────────────────
cat > "$INSTALL_DIR/devtool.conf" <<CONF
SSH_PORT=$SSH_PORT
RECOVERY_USER=$RECOVERY_USER
CONF

# ── Done ──────────────────────────────────────────────────────────────────────
MY_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo -e "${BOLD}${GREEN}"
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║  Installation complete!                                  ║"
echo "  ╠══════════════════════════════════════════════════════════╣"
printf "  ║  User   : %-46s║\n" "$RECOVERY_USER"
printf "  ║  Port   : %-46s║\n" "$SSH_PORT"
printf "  ║  IP     : %-46s║\n" "$MY_IP"
printf "  ║  Key    : %-46s║\n" "$INSTALL_DIR/keys/recovery_key"
echo "  ╠══════════════════════════════════════════════════════════╣"
echo "  ║  Connect from your workstation:                          ║"
printf "  ║    ssh -i recovery_key -p %s %s@%s\n" "$SSH_PORT" "$RECOVERY_USER" "$MY_IP"
echo "  ╠══════════════════════════════════════════════════════════╣"
echo "  ║  Check status :  usb-ssh-devtool-status                  ║"
echo "  ║  Remove access:  sudo usb-ssh-devtool-cleanup            ║"
echo "  ║  Uninstall    :  sudo ./usb-ssh-devtool.pkg --uninstall  ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

exit 0

__PAYLOAD__

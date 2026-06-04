# USB SSH Devtool

A portable recovery toolkit that lives on a USB drive and provisions SSH access
on a hardened Ubuntu system — whether via live-boot chroot or direct installation.

## Architecture

```
usb-ssh-devtool/
├── scripts/
│   ├── 1_prepare_usb.sh     # Partition USB + copy payload + generate SSH keypair
│   ├── 2_recover_ssh.sh     # Live-USB: chroot into target, enable SSH
│   ├── 3_install_agent.sh   # Direct: install SSH agent on running system
│   └── 4_cleanup.sh         # Remove recovery access when done
├── keys/
│   ├── recovery_key         # ED25519 private key (KEEP SECURE, never commit)
│   └── recovery_key.pub     # Public key deployed to target
└── config/
    ├── sshd_hardened.conf   # Reference sshd config applied during recovery
    └── udev_autorun.rules   # Optional: trigger service on USB insert
```

## Workflow

### Path A — Live USB (machine is locked down, no shell access)

```
┌─────────────────────────────────────────────────────────┐
│ On your workstation (any Linux)                         │
│   sudo ./scripts/1_prepare_usb.sh /dev/sdX ubuntu.iso  │
└───────────────────────────┬─────────────────────────────┘
                            │ plug USB into target, boot from it
┌───────────────────────────▼─────────────────────────────┐
│ Inside live Ubuntu environment on target                │
│   sudo ./scripts/2_recover_ssh.sh                       │
│   # auto-detects Ubuntu partition, chroots, patches     │
└───────────────────────────┬─────────────────────────────┘
                            │ reboot into installed system
┌───────────────────────────▼─────────────────────────────┐
│ From workstation                                        │
│   ssh -i keys/recovery_key devrecovery@<target-ip>     │
└─────────────────────────────────────────────────────────┘
```

### Path B — Direct install (you have physical or console access)

```bash
# On the target machine (plug in USB, mount it)
sudo mount /dev/sdX2 /mnt/usb
sudo /mnt/usb/devtool/scripts/3_install_agent.sh --port 2222
```

## Options

| Script | Key flags |
|--------|-----------|
| `1_prepare_usb.sh` | `/dev/sdX` `[ubuntu.iso]` |
| `2_recover_ssh.sh` | `--target-disk /dev/sdaX` `--port 2222` `--user myuser` |
| `3_install_agent.sh` | `--port 2222` `--user myuser` |
| `4_cleanup.sh` | `--user myuser` `--port 2222` |

## What it handles on a hardened Ubuntu system

| Hardening measure | How devtool handles it |
|-------------------|------------------------|
| `sshd` disabled   | `systemctl enable/start ssh` via chroot or direct |
| UFW blocking SSH  | `ufw allow <port>/tcp` |
| iptables DROP     | Inserts ACCEPT rule at position 1 |
| fail2ban          | Adds RFC1918 `ignoreip` to `jail.local` |
| No authorized keys | Deploys ED25519 public key to `~/.ssh/authorized_keys` |
| Password-only auth | Sets `PubkeyAuthentication yes` in sshd_config |
| `AllowUsers` list | Appends recovery user to existing list |

## Security notes

- The private key (`keys/recovery_key`) never leaves the USB drive.
- Recovery user has a locked password — key-only login.
- Run `4_cleanup.sh` to fully remove all recovery artifacts after use.
- The udev autorun rule is opt-in; the tool does NOT auto-execute on insert by default.

## Requirements

| Tool | Used by |
|------|---------|
| `sgdisk` (gdisk) | `1_prepare_usb.sh` |
| `rsync` | `1_prepare_usb.sh` |
| `ssh-keygen` | `1_prepare_usb.sh` |
| Standard live Ubuntu | `2_recover_ssh.sh` |
| `openssh-server` | `3_install_agent.sh` (auto-installed) |

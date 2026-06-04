USB SSH Devtool — Mac Client
============================

This package installed:
  ~/.ssh/usb_devtool_recovery_key   — ED25519 private key
  ~/.ssh/config                     — SSH alias "devtool-target"
  /usr/local/bin/usb-ssh-devtool-connect
  /usr/local/bin/usb-ssh-devtool-mac-cleanup

Quick connect:
  usb-ssh-devtool-connect devrecovery@<target-ip>
  usb-ssh-devtool-connect devrecovery@<target-ip> --port 2222

Or via SSH alias (after editing ~/.ssh/config with the real IP):
  ssh devtool-target

Remove everything:
  usb-ssh-devtool-mac-cleanup

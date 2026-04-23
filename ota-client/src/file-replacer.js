'use strict';
const fs = require('fs');
const path = require('path');

const isWindows = process.platform === 'win32';

// Tier 3: MoveFileExW via ffi-napi (Windows only, optional dependency)
let kernel32 = null;
function loadKernel32() {
  if (!isWindows || kernel32 !== null) return kernel32;
  try {
    const ffi = require('ffi-napi');
    kernel32 = ffi.Library('kernel32', {
      MoveFileExW: ['bool', ['string', 'string', 'uint32']]
    });
  } catch {
    kernel32 = false; // ffi-napi not available
  }
  return kernel32;
}

const MOVEFILE_REPLACE_EXISTING   = 0x00000001;
const MOVEFILE_DELAY_UNTIL_REBOOT = 0x00000004;

class FileReplacer {
  constructor(logger) {
    this.logger = logger;
  }

  backupFile(src, backupDir) {
    if (!fs.existsSync(src)) return null;
    fs.mkdirSync(backupDir, { recursive: true });
    const dest = path.join(backupDir, path.basename(src));
    fs.copyFileSync(src, dest);
    return dest;
  }

  restoreFile(backupPath, destination) {
    if (!fs.existsSync(backupPath)) {
      this.logger.warn(`Backup not found, cannot restore: ${backupPath}`);
      return false;
    }
    return this.replace(backupPath, destination, null, true);
  }

  replace(src, dst, backupDir, isRestore = false) {
    if (!fs.existsSync(src)) throw new Error(`Source file not found: ${src}`);

    const dstDir = path.dirname(dst);
    if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });

    // Backup before replacing (skip if restoring to avoid recursion)
    if (!isRestore && backupDir && fs.existsSync(dst)) {
      this.backupFile(dst, backupDir);
    }

    // Tier 1: Direct atomic rename (same volume)
    const tmp = dst + `.ota_tmp_${process.pid}`;
    try {
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, dst);
      this.logger.debug(`Tier 1 replace: ${dst}`);
      return 'direct';
    } catch (e1) {
      try { fs.unlinkSync(tmp); } catch {}
      this.logger.debug(`Tier 1 failed (${e1.code}), trying Tier 2: ${dst}`);
    }

    // Tier 2: Rename current dst → .old, then copy new file in
    const oldPath = dst + `.old_${process.pid}`;
    try {
      if (fs.existsSync(dst)) fs.renameSync(dst, oldPath);
      fs.copyFileSync(src, dst);
      // Schedule cleanup of .old file
      try { fs.unlinkSync(oldPath); } catch {}
      this.logger.debug(`Tier 2 replace: ${dst}`);
      return 'rename-copy';
    } catch (e2) {
      // Try to restore the .old file
      try {
        if (fs.existsSync(oldPath)) fs.renameSync(oldPath, dst);
      } catch {}
      this.logger.debug(`Tier 2 failed (${e2.code}), trying Tier 3: ${dst}`);
    }

    // Tier 3: MoveFileEx DELAY_UNTIL_REBOOT (Windows only)
    if (isWindows) {
      const lib = loadKernel32();
      if (lib) {
        try {
          const ok = lib.MoveFileExW(
            src,
            dst,
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_DELAY_UNTIL_REBOOT
          );
          if (ok) {
            this.logger.warn(`Tier 3 (reboot-pending) scheduled: ${dst}`);
            return 'reboot-pending';
          }
        } catch (e3) {
          this.logger.debug(`Tier 3 MoveFileExW failed: ${e3.message}`);
        }
      }
    }

    // Tier 4: Write pending-reboot flag
    const flagPath = path.join(path.dirname(dst), 'pending-reboot.json');
    const flag = { src, dst, scheduled_at: new Date().toISOString() };
    try {
      fs.writeFileSync(flagPath, JSON.stringify(flag, null, 2));
      this.logger.warn(`Tier 4 deferred flag written: ${flagPath}`);
      return 'deferred';
    } catch (e4) {
      throw new Error(`All replacement tiers failed for ${dst}: ${e4.message}`);
    }
  }

  cleanupStaleFiles(directory, pattern = /\.old_\d+$/) {
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory)) {
      if (pattern.test(name)) {
        try { fs.unlinkSync(path.join(directory, name)); } catch {}
      }
    }
  }
}

module.exports = { FileReplacer };

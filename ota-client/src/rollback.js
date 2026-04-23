'use strict';
const fs = require('fs');
const path = require('path');

class RollbackManager {
  constructor(stateDir, logger, serviceManager, fileReplacer) {
    this.stateDir = stateDir;
    this.backupsDir = path.join(stateDir, 'backups');
    this.logger = logger;
    this.serviceManager = serviceManager;
    this.fileReplacer = fileReplacer;
  }

  _ensureDir() {
    if (!fs.existsSync(this.backupsDir)) {
      fs.mkdirSync(this.backupsDir, { recursive: true });
    }
  }

  createCheckpoint(fromVersion, toVersion, packageId, files, targets) {
    this._ensureDir();
    const id = `${Date.now()}_v${fromVersion}`;
    const checkpointDir = path.join(this.backupsDir, id);
    fs.mkdirSync(checkpointDir, { recursive: true });

    const fileManifest = [];
    for (const file of files) {
      if (!file.backup) continue;
      const dst = file.destination;
      if (fs.existsSync(dst)) {
        const backupPath = this.fileReplacer.backupFile(dst, checkpointDir);
        if (backupPath) {
          fileManifest.push({ original: dst, backup: backupPath });
        }
      }
    }

    const checkpoint = {
      id,
      created_at: new Date().toISOString(),
      from_version: fromVersion,
      to_version: toVersion,
      package_id: packageId,
      backup_dir: checkpointDir,
      file_manifest: fileManifest,
      targets: targets.map(t => t.name || t.process_name || 'file_only'),
      status: 'active'
    };

    fs.writeFileSync(
      path.join(checkpointDir, 'checkpoint.json'),
      JSON.stringify(checkpoint, null, 2)
    );

    this.logger.info(`Rollback checkpoint created: ${id} (${fileManifest.length} files backed up)`);
    return checkpoint;
  }

  async rollback(checkpoint, targets, config) {
    this.logger.warn(`Rolling back to version ${checkpoint.from_version}`);

    // Stop all targets
    for (const target of targets) {
      try { await this.serviceManager.stopTarget(target); } catch (e) {
        this.logger.warn(`Stop failed during rollback (${target.name || target.process_name}): ${e.message}`);
      }
    }

    // Restore backed-up files
    let allRestored = true;
    for (const entry of checkpoint.file_manifest) {
      try {
        this.fileReplacer.restoreFile(entry.backup, entry.original);
        this.logger.info(`Restored: ${entry.original}`);
      } catch (e) {
        this.logger.error(`Failed to restore ${entry.original}: ${e.message}`);
        allRestored = false;
      }
    }

    // Restart targets
    for (const target of targets) {
      try { await this.serviceManager.startTarget(target, config); } catch (e) {
        this.logger.warn(`Start failed during rollback (${target.name || target.process_name}): ${e.message}`);
      }
    }

    // Mark checkpoint used
    checkpoint.status = 'used';
    const cpFile = path.join(checkpoint.backup_dir, 'checkpoint.json');
    if (fs.existsSync(cpFile)) {
      fs.writeFileSync(cpFile, JSON.stringify(checkpoint, null, 2));
    }

    this.logger.info(`Rollback complete. Files restored: ${allRestored}`);
    return allRestored;
  }

  prune(keepCount = 3) {
    this._ensureDir();
    const entries = fs.readdirSync(this.backupsDir)
      .filter(d => fs.statSync(path.join(this.backupsDir, d)).isDirectory())
      .sort(); // ascending by timestamp prefix

    const toDelete = entries.slice(0, Math.max(0, entries.length - keepCount));
    for (const dir of toDelete) {
      try {
        fs.rmSync(path.join(this.backupsDir, dir), { recursive: true, force: true });
        this.logger.debug(`Pruned old backup: ${dir}`);
      } catch (e) {
        this.logger.warn(`Failed to prune backup ${dir}: ${e.message}`);
      }
    }
  }
}

module.exports = { RollbackManager };

'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { verifyPackage } = require('./verifier');
const { loadPackage, cleanupExtract } = require('./package-parser');
const { computeSha256 } = require('./verifier');

class Updater {
  constructor(config, logger, serviceManager, fileReplacer, rollbackManager) {
    this.config = config;
    this.logger = logger;
    this.serviceMgr = serviceManager;
    this.fileReplacer = fileReplacer;
    this.rollback = rollbackManager;
  }

  async applyUpdate(zipPath, updateMeta) {
    const { version, packageId, sha256Hash, fileMappings = [] } = updateMeta;
    const workDir = this.config.agent.workDir;
    let pkg = null;
    let checkpoint = null;

    this.logger.info(`Applying update to version ${version} (package ${packageId})`);

    try {
      // 1. Verify integrity
      this.logger.info('Verifying package integrity...');
      await verifyPackage(zipPath, sha256Hash);

      // 2. Parse manifest
      this.logger.info('Parsing package manifest...');
      pkg = loadPackage(zipPath, workDir, fileMappings);

      // 3. Create rollback checkpoint
      this.logger.info('Creating rollback checkpoint...');
      checkpoint = this.rollback.createCheckpoint(
        this.config.agent.currentVersion,
        version,
        packageId,
        pkg.files,
        pkg.targets
      );

      // 4. Run pre-update script
      if (pkg.scripts.preUpdate && fs.existsSync(pkg.scripts.preUpdate)) {
        this.logger.info('Running pre-update script...');
        this._runScript(pkg.scripts.preUpdate);
      }

      // 5. Stop all targets
      this.logger.info('Stopping targets...');
      for (const target of pkg.targets) {
        await this.serviceMgr.stopTarget(target);
      }

      // 6. Replace files
      this.logger.info(`Replacing ${pkg.files.length} files...`);
      for (const file of pkg.files) {
        if (!fs.existsSync(file.sourcePath)) {
          throw new Error(`Source file missing in package: ${file.source}`);
        }
        const tier = this.fileReplacer.replace(
          file.sourcePath,
          file.destination,
          checkpoint.backup_dir
        );
        this.logger.info(`Replaced [${tier}]: ${file.destination}`);
      }

      // 7. Start targets
      this.logger.info('Starting targets...');
      for (const target of pkg.targets) {
        await this.serviceMgr.startTarget(target, this.config);
      }

      // 8. Run post-update script
      if (pkg.scripts.postUpdate && fs.existsSync(pkg.scripts.postUpdate)) {
        this.logger.info('Running post-update script...');
        this._runScript(pkg.scripts.postUpdate);
      }

      // 9. Health check
      this.logger.info('Running health check...');
      await this.serviceMgr.healthCheck(pkg.targets, this.config, pkg.healthCheck);

      // 10. Verify file_only targets: all destination files exist
      for (const target of pkg.targets) {
        if (target.type === 'file_only') {
          for (const file of pkg.files) {
            if (!fs.existsSync(file.destination)) {
              throw new Error(`File-only health check failed: ${file.destination} not found`);
            }
          }
        }
      }

      // Success
      this.logger.info(`Update to ${version} applied successfully`);
      this.rollback.prune(this.config.update.backupKeepCount || 3);
      cleanupExtract(pkg.extractDir);
      return { success: true, version };

    } catch (err) {
      this.logger.error(`Update failed: ${err.message}`);

      if (checkpoint && pkg && pkg.rollbackOnFailure) {
        this.logger.warn('Initiating rollback...');
        try {
          await this.rollback.rollback(checkpoint, pkg.targets, this.config);
        } catch (rbErr) {
          this.logger.error(`Rollback also failed: ${rbErr.message}`);
        }
      }

      if (pkg) cleanupExtract(pkg.extractDir);
      return { success: false, error: err.message, rolledBack: !!(checkpoint && pkg && pkg.rollbackOnFailure) };
    }
  }

  _runScript(scriptPath) {
    try {
      execFileSync(process.execPath, [scriptPath], {
        timeout: 30000,
        stdio: 'pipe'
      });
    } catch (e) {
      throw new Error(`Script ${scriptPath} failed: ${e.message}`);
    }
  }
}

module.exports = { Updater };

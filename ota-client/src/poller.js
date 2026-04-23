'use strict';
const fs = require('fs');
const path = require('path');
const { GrpcOtaClient } = require('./grpc-client');
const { HttpOtaClient } = require('./http-client');
const { Updater } = require('./updater');
const { ServiceManager } = require('./service-manager');
const { FileReplacer } = require('./file-replacer');
const { RollbackManager } = require('./rollback');

class UpdatePoller {
  constructor(config, logger, saveConfigFn) {
    this.config = config;
    this.logger = logger;
    this.saveConfig = saveConfigFn;
    this.stopped = false;
    this._timer = null;
    this._transport = null;

    this.serviceMgr = new ServiceManager(logger);
    this.fileReplacer = new FileReplacer(logger);
    this.rollbackMgr = new RollbackManager(
      config.agent.stateDir,
      logger,
      this.serviceMgr,
      this.fileReplacer
    );
    this.updater = new Updater(config, logger, this.serviceMgr, this.fileReplacer, this.rollbackMgr);
  }

  async start() {
    this.stopped = false;
    this.logger.info('OTA poller starting...');

    await this._ensureRegistered();
    this._transport = await this._buildTransport();

    this._schedule();
  }

  stop() {
    this.stopped = true;
    if (this._timer) clearTimeout(this._timer);
    if (this._transport && this._transport.destroy) this._transport.destroy();
    this.logger.info('OTA poller stopped');
  }

  _schedule() {
    if (this.stopped) return;
    this._timer = setTimeout(async () => {
      await this._pollOnce();
      this._schedule();
    }, this.config.agent.pollIntervalMs || 300000);
  }

  async _ensureRegistered() {
    if (this.config.agent.deviceId && this.config.agent.authToken) return;

    this.logger.info('No device ID found, registering with server...');
    const { v4: uuidv4 } = require('uuid');
    const os = require('os');

    const deviceId = require('uuid').v4();
    const hostname = os.hostname();
    const osVersion = `${process.platform} ${os.release()}`;
    const currentVersion = this.config.agent.currentVersion || '0.0.0';

    // Try gRPC first, then HTTP
    let result = null;
    if (this.config.server.preferGrpc) {
      try {
        const grpcClient = new GrpcOtaClient(this.config, this.logger);
        if (grpcClient.connect()) {
          result = await grpcClient.register(deviceId, hostname, osVersion, currentVersion);
          grpcClient.destroy();
        }
      } catch (e) {
        this.logger.warn(`gRPC registration failed: ${e.message}, trying HTTP`);
      }
    }

    if (!result) {
      const httpClient = new HttpOtaClient(this.config, this.logger);
      result = await httpClient.register(deviceId, hostname, osVersion, currentVersion);
    }

    this.config.agent.deviceId = result.device_id;
    this.config.agent.authToken = result.auth_token;
    this.saveConfig(this.config);
    this.logger.info(`Registered as device: ${result.device_id}`);
  }

  async _buildTransport() {
    if (this.config.server.preferGrpc) {
      const grpcClient = new GrpcOtaClient(this.config, this.logger);
      if (grpcClient.connect()) {
        this.logger.info('Using gRPC transport');
        return { type: 'grpc', client: grpcClient };
      }
      this.logger.warn('gRPC unavailable, falling back to HTTP');
    }
    this.logger.info('Using HTTP transport');
    return { type: 'http', client: new HttpOtaClient(this.config, this.logger) };
  }

  async _pollOnce() {
    const { deviceId, authToken, currentVersion } = this.config.agent;
    this.logger.debug(`Polling for updates (current: ${currentVersion})...`);

    let result;
    try {
      const { client, type } = this._transport;
      if (type === 'grpc') {
        result = await client.poll(deviceId, authToken, currentVersion);
      } else {
        result = await client.poll(deviceId, authToken, currentVersion);
      }
    } catch (err) {
      this.logger.warn(`Poll failed: ${err.message}`);
      // Attempt transport switch on repeated failures
      if (this._transport.type === 'grpc') {
        this.logger.warn('Switching to HTTP transport after gRPC error');
        if (this._transport.client.destroy) this._transport.client.destroy();
        this._transport = { type: 'http', client: new HttpOtaClient(this.config, this.logger) };
      }
      return;
    }

    if (!result.updateAvailable) {
      this.logger.debug('No update available');
      return;
    }

    this.logger.info(`Update available: ${result.version} (package ${result.packageId})`);

    // Save zip to workDir
    const workDir = this.config.agent.workDir;
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
    const zipPath = path.join(workDir, `update_${result.version}.zip`);

    try {
      fs.writeFileSync(zipPath, result.zipBuffer);
      this.logger.info(`Downloaded ${result.zipBuffer.length} bytes → ${zipPath}`);
    } catch (e) {
      this.logger.error(`Failed to write zip: ${e.message}`);
      return;
    }

    // Report downloading status
    await this._reportStatus(result.packageId, 'downloading', null, null);

    // Apply update
    await this._reportStatus(result.packageId, 'applying', null, null);
    const applyResult = await this.updater.applyUpdate(zipPath, result);

    // Cleanup zip
    try { fs.unlinkSync(zipPath); } catch {}

    if (applyResult.success) {
      this.config.agent.currentVersion = result.version;
      this.saveConfig(this.config);
      await this._reportStatus(result.packageId, 'success', null, result.version);
      this.logger.info(`Successfully updated to ${result.version}`);
    } else {
      const status = applyResult.rolledBack ? 'rolled_back' : 'failed';
      await this._reportStatus(result.packageId, status, applyResult.error, null);
      this.logger.error(`Update failed (${status}): ${applyResult.error}`);
    }
  }

  async _reportStatus(packageId, status, errorMessage, installedVersion) {
    const { deviceId, authToken } = this.config.agent;
    try {
      const { client, type } = this._transport;
      if (type === 'grpc') {
        await client.reportStatus(deviceId, authToken, packageId, status, errorMessage, installedVersion);
      } else {
        await client.reportStatus(deviceId, authToken, packageId, status, errorMessage, installedVersion);
      }
    } catch (e) {
      this.logger.warn(`Failed to report status ${status}: ${e.message}`);
    }
  }
}

module.exports = { UpdatePoller };

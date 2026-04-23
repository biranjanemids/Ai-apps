'use strict';
const { execSync, spawn } = require('child_process');

const isWindows = process.platform === 'win32';

function scExec(args) {
  try {
    const result = execSync(`sc ${args}`, { encoding: 'utf8', timeout: 10000 });
    return { success: true, output: result };
  } catch (e) {
    return { success: false, output: e.message };
  }
}

function getServiceState(name) {
  const { output } = scExec(`query "${name}"`);
  const match = output && output.match(/STATE\s+:\s+\d+\s+(\w+)/);
  return match ? match[1] : null;
}

function pollUntil(fn, targetState, timeoutMs, intervalMs = 1000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const state = fn();
      if (state === targetState) return resolve(true);
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(check, intervalMs);
    };
    check();
  });
}

class ServiceManager {
  constructor(logger) {
    this.logger = logger;
  }

  stopService(name, timeoutMs = 30000) {
    if (!isWindows) {
      this.logger.warn(`[non-Windows] would stop service: ${name}`);
      return Promise.resolve(true);
    }
    this.logger.info(`Stopping Windows service: ${name}`);
    scExec(`stop "${name}"`);
    return pollUntil(() => getServiceState(name), 'STOPPED', timeoutMs);
  }

  startService(name, timeoutMs = 60000) {
    if (!isWindows) {
      this.logger.warn(`[non-Windows] would start service: ${name}`);
      return Promise.resolve(true);
    }
    this.logger.info(`Starting Windows service: ${name}`);
    scExec(`start "${name}"`);
    return pollUntil(() => getServiceState(name), 'RUNNING', timeoutMs);
  }

  isServiceRunning(name) {
    if (!isWindows) return true;
    return getServiceState(name) === 'RUNNING';
  }

  killProcess(processName) {
    if (!isWindows) {
      this.logger.warn(`[non-Windows] would kill process: ${processName}`);
      return;
    }
    this.logger.info(`Killing process: ${processName}`);
    try {
      execSync(`taskkill /IM "${processName}" /F`, { encoding: 'utf8', timeout: 10000 });
    } catch {
      // Process may already be stopped
    }
  }

  startProcess(restartCmd, restartArgs = []) {
    if (!isWindows) {
      this.logger.warn(`[non-Windows] would spawn: ${restartCmd}`);
      return;
    }
    this.logger.info(`Spawning process: ${restartCmd}`);
    const child = spawn(restartCmd, restartArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
  }

  isProcessRunning(processName) {
    if (!isWindows) return true;
    try {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${processName}"`, { encoding: 'utf8' });
      return out.toLowerCase().includes(processName.toLowerCase());
    } catch {
      return false;
    }
  }

  async stopTarget(target) {
    if (target.type === 'windows_service') {
      const stopped = await this.stopService(target.name);
      if (!stopped) throw new Error(`Timed out stopping service: ${target.name}`);
    } else if (target.type === 'process') {
      this.killProcess(target.process_name);
    }
    // file_only: no-op
  }

  async startTarget(target, config) {
    if (target.type === 'windows_service') {
      const started = await this.startService(target.name, config.update.serviceStartTimeoutMs);
      if (!started) throw new Error(`Timed out starting service: ${target.name}`);
    } else if (target.type === 'process') {
      this.startProcess(target.restart_cmd, target.restart_args || []);
    }
    // file_only: no-op
  }

  async healthCheck(targets, config, healthCheckDef) {
    const timeoutMs = (healthCheckDef.timeout_seconds || 60) * 1000;
    const start = Date.now();

    for (const target of targets) {
      if (target.type === 'windows_service') {
        const ok = await pollUntil(
          () => getServiceState(target.name),
          'RUNNING',
          timeoutMs
        );
        if (!ok) throw new Error(`Health check failed: service ${target.name} not RUNNING`);
      } else if (target.type === 'process') {
        const ok = await pollUntil(
          () => this.isProcessRunning(target.process_name) ? 'RUNNING' : null,
          'RUNNING',
          timeoutMs
        );
        if (!ok) throw new Error(`Health check failed: process ${target.process_name} not found`);
      }
      // file_only: verified by updater checking destination files exist
    }
  }
}

module.exports = { ServiceManager };

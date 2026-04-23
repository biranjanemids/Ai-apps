'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  server: {
    httpUrl: 'https://localhost:8443',
    grpcEndpoint: 'localhost:50051',
    preferGrpc: true,
    timeoutMs: 30000,
    retryAttempts: 3,
    tlsCert: ''
  },
  agent: {
    deviceId: '',
    authToken: '',
    currentVersion: '0.0.0',
    pollIntervalMs: 300000,
    workDir:   path.join(os.homedir(), 'OTAAgent', 'work'),
    stateDir:  path.join(os.homedir(), 'OTAAgent', 'state'),
    logFile:   path.join(os.homedir(), 'OTAAgent', 'logs', 'ota-agent.log')
  },
  update: {
    backupKeepCount: 3,
    serviceStopTimeoutMs: 30000,
    serviceStartTimeoutMs: 60000,
    healthCheckTimeoutMs: 60000
  }
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULTS);
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

function saveConfig(data) {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}

function ensureDirs(config) {
  const dirs = [
    config.agent.workDir,
    config.agent.stateDir,
    path.join(config.agent.stateDir, 'backups'),
    path.dirname(config.agent.logFile)
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = { loadConfig, saveConfig, ensureDirs, CONFIG_PATH };

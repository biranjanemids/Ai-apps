'use strict';
/**
 * Install or remove the OTA Update Agent as a Windows service.
 *
 * Usage (elevated command prompt):
 *   node install-service.js install
 *   node install-service.js remove
 */
const path = require('path');

const SVC_NAME        = 'OTAUpdateAgent';
const SVC_DISPLAY     = 'OTA Update Agent';
const SVC_DESCRIPTION = 'Polls an OTA server, downloads and applies Windows service updates automatically';
const AGENT_SCRIPT    = path.join(__dirname, 'agent.js');

function getService() {
  let Service;
  try {
    Service = require('node-windows').Service;
  } catch {
    console.error('node-windows is not installed. Run: npm install node-windows');
    process.exit(1);
  }

  return new Service({
    name: SVC_NAME,
    description: SVC_DESCRIPTION,
    script: AGENT_SCRIPT,
    nodeOptions: [],
    env: [{ name: 'OTA_CONSOLE_LOG', value: '0' }],
    workingDirectory: __dirname,
    allowServiceLogon: true
  });
}

function install() {
  if (process.platform !== 'win32') {
    console.error('Service installation is only supported on Windows.');
    process.exit(1);
  }

  const svc = getService();

  svc.on('install', () => {
    console.log(`Service "${SVC_NAME}" installed successfully.`);
    svc.start();
  });

  svc.on('start', () => {
    console.log(`Service "${SVC_NAME}" started.`);
    console.log('Check status: sc query OTAUpdateAgent');
    console.log(`Logs: ${require('./src/config').loadConfig().agent.logFile}`);
  });

  svc.on('error', (err) => {
    console.error(`Service error: ${err.message || err}`);
  });

  console.log(`Installing Windows service "${SVC_NAME}"...`);
  svc.install();
}

function remove() {
  if (process.platform !== 'win32') {
    console.error('Service removal is only supported on Windows.');
    process.exit(1);
  }

  const svc = getService();

  svc.on('uninstall', () => {
    console.log(`Service "${SVC_NAME}" removed successfully.`);
  });

  svc.on('error', (err) => {
    console.error(`Service error: ${err.message || err}`);
  });

  console.log(`Removing Windows service "${SVC_NAME}"...`);
  svc.stop();
  svc.uninstall();
}

const cmd = process.argv[2];
if (cmd === 'install') {
  install();
} else if (cmd === 'remove') {
  remove();
} else {
  console.log(`Usage: node install-service.js [install|remove]`);
  console.log('  install  — Register and start the OTA Update Agent Windows service');
  console.log('  remove   — Stop and unregister the service');
  process.exit(1);
}

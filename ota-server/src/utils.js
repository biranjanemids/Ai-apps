'use strict';
const semver = require('semver');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function isNewer(serverVersion, clientVersion) {
  return (
    semver.valid(serverVersion) &&
    semver.valid(clientVersion) &&
    semver.lt(clientVersion, serverVersion)
  );
}

function now() {
  return new Date().toISOString();
}

function generateSelfSignedCert(certPath, keyPath) {
  const dir = path.dirname(certPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 3650 -nodes -subj "/CN=ota-server"`,
      { stdio: 'ignore' }
    );
    return true;
  } catch {
    return false;
  }
}

function loadOrGenerateCert(certPath, keyPath) {
  const absKey = path.resolve(keyPath);
  const absCert = path.resolve(certPath);
  if (!fs.existsSync(absCert) || !fs.existsSync(absKey)) {
    const ok = generateSelfSignedCert(absCert, absKey);
    if (!ok) throw new Error('Failed to generate TLS certificate. Is openssl installed?');
  }
  return { cert: fs.readFileSync(absCert), key: fs.readFileSync(absKey) };
}

module.exports = { isNewer, now, loadOrGenerateCert };

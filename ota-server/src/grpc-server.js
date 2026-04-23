'use strict';
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const fs = require('fs');
const semver = require('semver');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./db');
const { hashToken, generateToken } = require('./auth');
const { getPackageFilepath } = require('./storage');
const { now } = require('./utils');

const CHUNK_SIZE = 256 * 1024; // 256 KB per gRPC message

function loadProto() {
  const protoPath = path.join(__dirname, '..', 'proto', 'ota.proto');
  const pkg = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  });
  return grpc.loadPackageDefinition(pkg).ota;
}

function getDeviceByToken(authToken) {
  if (!authToken) return null;
  const hash = hashToken(authToken);
  const device = getDb().prepare(
    'SELECT * FROM devices WHERE auth_token_hash=? AND is_active=1'
  ).get(hash);
  if (device) {
    getDb().prepare('UPDATE devices SET last_seen=? WHERE device_id=?')
      .run(now(), device.device_id);
  }
  return device || null;
}

function getLatestUpdateForVersion(currentVersion) {
  const packages = getDb()
    .prepare('SELECT * FROM packages WHERE is_active=1 ORDER BY uploaded_at DESC')
    .all();
  for (const pkg of packages) {
    if (semver.valid(pkg.version) && semver.valid(currentVersion) && semver.lt(currentVersion, pkg.version)) {
      return pkg;
    }
  }
  return null;
}

function upsertJob(deviceId, packageId) {
  const db = getDb();
  const existing = db.prepare(
    'SELECT id FROM update_jobs WHERE device_id=? AND package_id=?'
  ).get(deviceId, packageId);
  const ts = now();
  if (existing) {
    db.prepare(
      'UPDATE update_jobs SET status=?, updated_at=?, attempt_count=attempt_count+1 WHERE id=?'
    ).run('downloading', ts, existing.id);
  } else {
    db.prepare(
      'INSERT INTO update_jobs (device_id, package_id, status, created_at, attempt_count) VALUES (?,?,?,?,1)'
    ).run(deviceId, packageId, 'downloading', ts);
  }
}

// ── RPC handlers ──────────────────────────────────────────────────────────────

function registerHandler(call, callback) {
  const { device_id, hostname, os_version, current_version } = call.request;
  const db = getDb();
  const deviceId = device_id || uuidv4();
  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const ts = now();

  const existing = db.prepare('SELECT id FROM devices WHERE device_id=?').get(deviceId);
  if (existing) {
    db.prepare(
      'UPDATE devices SET hostname=?,os_version=?,current_version=?,auth_token_hash=?,last_seen=? WHERE device_id=?'
    ).run(hostname, os_version, current_version || '0.0.0', tokenHash, ts, deviceId);
  } else {
    db.prepare(
      'INSERT INTO devices (device_id,hostname,os_version,current_version,auth_token_hash,registered_at,last_seen) VALUES (?,?,?,?,?,?,?)'
    ).run(deviceId, hostname, os_version, current_version || '0.0.0', tokenHash, ts, ts);
  }
  callback(null, { auth_token: rawToken, device_id: deviceId });
}

function pollHandler(call) {
  const { auth_token, current_version } = call.request;

  const device = getDeviceByToken(auth_token);
  if (!device) {
    call.write({ update_available: false });
    call.end();
    return;
  }

  const effectiveVersion = current_version || device.current_version;
  const pkg = getLatestUpdateForVersion(effectiveVersion);
  if (!pkg) {
    call.write({ update_available: false });
    call.end();
    return;
  }

  const db = getDb();
  const mappings = db.prepare(
    'SELECT source_path, dest_path, file_type, backup FROM package_file_mappings WHERE package_id=? ORDER BY id'
  ).all(pkg.id);

  upsertJob(device.device_id, pkg.id);

  const filepath = getPackageFilepath(pkg.filename);
  if (!fs.existsSync(filepath)) {
    call.write({ update_available: false });
    call.end();
    return;
  }

  const fileBuffer = fs.readFileSync(filepath);
  const totalChunks = Math.ceil(fileBuffer.length / CHUNK_SIZE);

  for (let i = 0; i < totalChunks; i++) {
    const chunk = fileBuffer.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const msg = {
      update_available: true,
      chunk,
      last_chunk: i === totalChunks - 1
    };

    if (i === 0) {
      // Metadata only in first message
      msg.version = pkg.version;
      msg.package_name = pkg.package_name || pkg.filename;
      msg.package_id = pkg.id;
      msg.sha256_hash = pkg.sha256_hash;
      msg.release_notes = pkg.release_notes || '';
      msg.file_mappings = mappings.map(m => ({
        source_path: m.source_path,
        dest_path: m.dest_path,
        file_type: m.file_type,
        backup: !!m.backup
      }));
    }

    call.write(msg);
  }

  call.end();
}

function reportStatusHandler(call, callback) {
  const { auth_token, package_id, status, error_message, installed_version } = call.request;

  const device = getDeviceByToken(auth_token);
  if (!device) return callback(null, { ok: false });

  const db = getDb();
  db.prepare(
    'UPDATE update_jobs SET status=?, updated_at=?, error_message=? WHERE device_id=? AND package_id=?'
  ).run(status, now(), error_message || null, device.device_id, parseInt(package_id));

  if (status === 'success' && installed_version) {
    db.prepare('UPDATE devices SET current_version=?, last_seen=? WHERE device_id=?')
      .run(installed_version, now(), device.device_id);
  }

  callback(null, { ok: true });
}

// ── Server factory ────────────────────────────────────────────────────────────

function createGrpcServer() {
  const proto = loadProto();
  const server = new grpc.Server();
  server.addService(proto.OTAService.service, {
    Register: registerHandler,
    Poll: pollHandler,
    ReportStatus: reportStatusHandler
  });
  return server;
}

module.exports = { createGrpcServer };

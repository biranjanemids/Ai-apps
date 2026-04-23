'use strict';
const { getDb } = require('../db');
const { deviceGuard, adminGuard } = require('../auth');
const { getPackageFilepath } = require('../storage');
const { isNewer, now } = require('../utils');
const fs = require('fs');

function getLatestPackage(currentVersion) {
  const packages = getDb()
    .prepare('SELECT * FROM packages WHERE is_active=1 ORDER BY uploaded_at DESC')
    .all();
  for (const pkg of packages) {
    if (isNewer(pkg.version, currentVersion)) return pkg;
  }
  return null;
}

function isInRollout(deviceId, rolloutPercentage) {
  if (rolloutPercentage >= 100) return true;
  // Deterministic bucket from device_id hex bytes
  const hex = deviceId.replace(/-/g, '');
  const bucket = (parseInt(hex.slice(0, 4), 16)) % 100;
  return bucket < rolloutPercentage;
}

function upsertJob(db, deviceId, packageId, status) {
  const existing = db.prepare(
    'SELECT id FROM update_jobs WHERE device_id=? AND package_id=?'
  ).get(deviceId, packageId);
  const ts = now();
  if (existing) {
    db.prepare(
      'UPDATE update_jobs SET status=?, updated_at=?, attempt_count=attempt_count+1 WHERE id=?'
    ).run(status, ts, existing.id);
  } else {
    db.prepare(
      'INSERT INTO update_jobs (device_id, package_id, status, created_at, attempt_count) VALUES (?,?,?,?,1)'
    ).run(deviceId, packageId, status, ts);
  }
}

async function updatesRoutes(fastify) {
  // Client polls — server streams zip directly if clientVer < serverVer
  fastify.post('/updates/poll', { preHandler: deviceGuard }, async (request, reply) => {
    const { current_version } = request.body || {};
    if (!current_version) return reply.code(400).send({ error: 'current_version required' });

    const device = request.device;
    const pkg = getLatestPackage(current_version);
    if (!pkg) return reply.code(204).send();

    if (!isInRollout(device.device_id, pkg.rollout_percentage)) {
      return reply.code(204).send();
    }

    const db = getDb();
    const mappings = db.prepare(
      'SELECT source_path, dest_path, file_type, backup FROM package_file_mappings WHERE package_id=? ORDER BY id'
    ).all(pkg.id);

    upsertJob(db, device.device_id, pkg.id, 'downloading');

    const filepath = getPackageFilepath(pkg.filename);
    if (!fs.existsSync(filepath)) {
      return reply.code(404).send({ error: 'Package file not found on server' });
    }

    // Stream zip with metadata in response headers
    reply.raw.writeHead(200, {
      'Content-Type': 'application/zip',
      'X-Package-Version': pkg.version,
      'X-Package-Id': String(pkg.id),
      'X-SHA256': pkg.sha256_hash,
      'X-Package-Name': pkg.package_name || pkg.filename,
      'X-File-Mappings': JSON.stringify(mappings),
      'X-Release-Notes': pkg.release_notes || ''
    });

    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filepath);
      stream.pipe(reply.raw);
      stream.on('end', resolve);
      stream.on('error', reject);
    });
  });

  // Client reports update result
  fastify.post('/updates/status', { preHandler: deviceGuard }, async (request, reply) => {
    const { package_id, status, error_message, installed_version } = request.body || {};
    if (!package_id || !status) return reply.code(400).send({ error: 'package_id and status required' });

    const valid = ['success', 'failed', 'rolled_back', 'applying', 'downloading'];
    if (!valid.includes(status)) return reply.code(400).send({ error: 'Invalid status' });

    const db = getDb();
    db.prepare(
      'UPDATE update_jobs SET status=?, updated_at=?, error_message=? WHERE device_id=? AND package_id=?'
    ).run(status, now(), error_message || null, request.device.device_id, package_id);

    if (status === 'success' && installed_version) {
      db.prepare('UPDATE devices SET current_version=?, last_seen=? WHERE device_id=?')
        .run(installed_version, now(), request.device.device_id);
    }

    return reply.send({ ok: true });
  });

  // Admin: job history for a device
  fastify.get('/updates/history/:deviceId', { preHandler: adminGuard }, async (request, reply) => {
    const jobs = getDb().prepare(
      'SELECT * FROM update_jobs WHERE device_id=? ORDER BY created_at DESC'
    ).all(request.params.deviceId);
    return reply.send({ items: jobs, total: jobs.length });
  });
}

module.exports = updatesRoutes;

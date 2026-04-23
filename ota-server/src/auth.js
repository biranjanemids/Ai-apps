'use strict';
const crypto = require('crypto');
const { getDb } = require('./db');

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function verifyDeviceToken(rawToken) {
  if (!rawToken) return null;
  const hash = hashToken(rawToken);
  const db = getDb();
  const device = db.prepare(
    'SELECT * FROM devices WHERE auth_token_hash = ? AND is_active = 1'
  ).get(hash);
  if (device) {
    db.prepare('UPDATE devices SET last_seen = ? WHERE device_id = ?')
      .run(new Date().toISOString(), device.device_id);
  }
  return device || null;
}

function extractBearerToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

async function deviceGuard(request, reply) {
  const token = extractBearerToken(request.headers.authorization);
  const device = verifyDeviceToken(token);
  if (!device) return reply.code(401).send({ error: 'Unauthorized' });
  request.device = device;
}

async function adminGuard(request, reply) {
  const token = extractBearerToken(request.headers.authorization);
  if (!token || token !== process.env.ADMIN_SECRET) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}

module.exports = { hashToken, generateToken, verifyDeviceToken, deviceGuard, adminGuard, extractBearerToken };

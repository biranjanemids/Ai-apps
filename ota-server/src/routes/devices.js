'use strict';
const { getDb } = require('../db');
const { hashToken, generateToken, deviceGuard, adminGuard } = require('../auth');
const { now } = require('../utils');
const { v4: uuidv4 } = require('uuid');

async function devicesRoutes(fastify) {
  fastify.post('/devices/register', async (request, reply) => {
    const { device_id, hostname, os_version, current_version } = request.body || {};
    if (!hostname || !os_version) {
      return reply.code(400).send({ error: 'hostname and os_version required' });
    }

    const db = getDb();
    const deviceId = device_id || uuidv4();
    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const ts = now();

    const existing = db.prepare('SELECT id FROM devices WHERE device_id = ?').get(deviceId);
    if (existing) {
      db.prepare(
        'UPDATE devices SET hostname=?, os_version=?, current_version=?, auth_token_hash=?, last_seen=? WHERE device_id=?'
      ).run(hostname, os_version, current_version || '0.0.0', tokenHash, ts, deviceId);
    } else {
      db.prepare(
        'INSERT INTO devices (device_id, hostname, os_version, current_version, auth_token_hash, registered_at, last_seen) VALUES (?,?,?,?,?,?,?)'
      ).run(deviceId, hostname, os_version, current_version || '0.0.0', tokenHash, ts, ts);
    }

    return reply.send({ auth_token: rawToken, device_id: deviceId });
  });

  fastify.get('/devices/me', { preHandler: deviceGuard }, async (request, reply) => {
    const { auth_token_hash, ...safe } = request.device;
    return reply.send(safe);
  });

  fastify.put('/devices/me/version', { preHandler: deviceGuard }, async (request, reply) => {
    const { current_version } = request.body || {};
    if (!current_version) return reply.code(400).send({ error: 'current_version required' });
    getDb().prepare('UPDATE devices SET current_version=?, last_seen=? WHERE device_id=?')
      .run(current_version, now(), request.device.device_id);
    return reply.send({ ok: true });
  });

  fastify.get('/devices/', { preHandler: adminGuard }, async (request, reply) => {
    const devices = getDb().prepare(
      'SELECT id,device_id,hostname,os_version,current_version,registered_at,last_seen,is_active FROM devices ORDER BY registered_at DESC'
    ).all();
    return reply.send({ items: devices, total: devices.length });
  });
}

module.exports = devicesRoutes;

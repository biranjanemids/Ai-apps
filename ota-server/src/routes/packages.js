'use strict';
const { getDb } = require('../db');
const { adminGuard, deviceGuard } = require('../auth');
const { savePackageFile, validatePackageZip, getPackageFilepath, deletePackageFile } = require('../storage');
const { now } = require('../utils');
const fs = require('fs');

async function packagesRoutes(fastify) {
  // Upload a package (multipart)
  fastify.post('/packages/upload', { preHandler: adminGuard }, async (request, reply) => {
    const parts = request.parts();
    let fileBuffer, fileName, version, releaseNotes, targetServices, minClientVersion;

    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'file') {
        fileName = part.filename;
        const chunks = [];
        for await (const chunk of part.file) chunks.push(chunk);
        fileBuffer = Buffer.concat(chunks);
      } else if (part.type === 'field') {
        if (part.fieldname === 'version')            version = part.value;
        if (part.fieldname === 'release_notes')      releaseNotes = part.value;
        if (part.fieldname === 'target_services')    targetServices = part.value;
        if (part.fieldname === 'min_client_version') minClientVersion = part.value;
      }
    }

    if (!fileBuffer || !version) {
      return reply.code(400).send({ error: 'file and version required' });
    }

    let result;
    try {
      result = await savePackageFile(fileBuffer, fileName, version);
    } catch (e) {
      return reply.code(500).send({ error: `Failed to save file: ${e.message}` });
    }

    let manifest;
    try {
      manifest = validatePackageZip(result.filepath);
    } catch (e) {
      deletePackageFile(result.filename);
      return reply.code(400).send({ error: `Invalid package: ${e.message}` });
    }

    const db = getDb();
    const ts = now();
    try {
      const info = db.prepare(`
        INSERT INTO packages (package_name, version, target_services, filename, sha256_hash, file_size, uploaded_at, release_notes, min_client_version)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        manifest.package_name || fileName,
        version,
        targetServices || JSON.stringify(manifest.targets?.map(t => t.name).filter(Boolean) || []),
        result.filename,
        result.sha256,
        result.fileSize,
        ts,
        releaseNotes || null,
        minClientVersion || '0.0.0'
      );
      return reply.code(201).send({
        package_id: info.lastInsertRowid,
        version,
        sha256_hash: result.sha256,
        file_size: result.fileSize
      });
    } catch (e) {
      deletePackageFile(result.filename);
      return reply.code(409).send({ error: `Version ${version} already exists` });
    }
  });

  // List packages
  fastify.get('/packages/', { preHandler: adminGuard }, async (request, reply) => {
    const { active_only } = request.query;
    const query = active_only === 'true'
      ? 'SELECT * FROM packages WHERE is_active=1 ORDER BY uploaded_at DESC'
      : 'SELECT * FROM packages ORDER BY uploaded_at DESC';
    const items = getDb().prepare(query).all();
    return reply.send({ items, total: items.length });
  });

  // Get package metadata
  fastify.get('/packages/:id', { preHandler: deviceGuard }, async (request, reply) => {
    const pkg = getDb().prepare('SELECT * FROM packages WHERE id=?').get(request.params.id);
    if (!pkg) return reply.code(404).send({ error: 'Package not found' });
    return reply.send(pkg);
  });

  // Toggle active / rollout percentage
  fastify.patch('/packages/:id', { preHandler: adminGuard }, async (request, reply) => {
    const { is_active, rollout_percentage } = request.body || {};
    const db = getDb();
    const pkg = db.prepare('SELECT id FROM packages WHERE id=?').get(request.params.id);
    if (!pkg) return reply.code(404).send({ error: 'Package not found' });
    if (is_active !== undefined) {
      db.prepare('UPDATE packages SET is_active=? WHERE id=?').run(is_active ? 1 : 0, request.params.id);
    }
    if (rollout_percentage !== undefined) {
      db.prepare('UPDATE packages SET rollout_percentage=? WHERE id=?').run(rollout_percentage, request.params.id);
    }
    return reply.send(db.prepare('SELECT * FROM packages WHERE id=?').get(request.params.id));
  });

  // Delete package
  fastify.delete('/packages/:id', { preHandler: adminGuard }, async (request, reply) => {
    const db = getDb();
    const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(request.params.id);
    if (!pkg) return reply.code(404).send({ error: 'Package not found' });
    db.prepare('DELETE FROM packages WHERE id=?').run(request.params.id);
    deletePackageFile(pkg.filename);
    return reply.send({ ok: true });
  });

  // --- File path mappings ---

  fastify.get('/packages/:id/mappings', { preHandler: adminGuard }, async (request, reply) => {
    const mappings = getDb().prepare(
      'SELECT * FROM package_file_mappings WHERE package_id=? ORDER BY id'
    ).all(request.params.id);
    return reply.send({ items: mappings, total: mappings.length });
  });

  fastify.post('/packages/:id/mappings', { preHandler: adminGuard }, async (request, reply) => {
    const { source_path, dest_path, file_type, backup } = request.body || {};
    if (!source_path || !dest_path) {
      return reply.code(400).send({ error: 'source_path and dest_path required' });
    }
    const ts = now();
    const info = getDb().prepare(
      'INSERT INTO package_file_mappings (package_id, source_path, dest_path, file_type, backup, created_at) VALUES (?,?,?,?,?,?)'
    ).run(request.params.id, source_path, dest_path, file_type || 'binary', backup !== false ? 1 : 0, ts);
    return reply.code(201).send({
      id: info.lastInsertRowid,
      package_id: parseInt(request.params.id),
      source_path,
      dest_path,
      file_type: file_type || 'binary',
      backup: backup !== false
    });
  });

  fastify.put('/packages/:id/mappings/:mid', { preHandler: adminGuard }, async (request, reply) => {
    const { dest_path, file_type, backup } = request.body || {};
    const db = getDb();
    db.prepare(
      'UPDATE package_file_mappings SET dest_path=COALESCE(?,dest_path), file_type=COALESCE(?,file_type), backup=COALESCE(?,backup), updated_at=? WHERE id=? AND package_id=?'
    ).run(
      dest_path || null,
      file_type || null,
      backup !== undefined ? (backup ? 1 : 0) : null,
      now(),
      request.params.mid,
      request.params.id
    );
    return reply.send(db.prepare('SELECT * FROM package_file_mappings WHERE id=?').get(request.params.mid));
  });

  fastify.delete('/packages/:id/mappings/:mid', { preHandler: adminGuard }, async (request, reply) => {
    getDb().prepare(
      'DELETE FROM package_file_mappings WHERE id=? AND package_id=?'
    ).run(request.params.mid, request.params.id);
    return reply.send({ ok: true });
  });
}

module.exports = packagesRoutes;

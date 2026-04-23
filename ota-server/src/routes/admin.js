'use strict';
const { getDb } = require('../db');
const { adminGuard } = require('../auth');

async function adminRoutes(fastify) {
  fastify.get('/admin/stats', { preHandler: adminGuard }, async (request, reply) => {
    const db = getDb();
    const total_devices  = db.prepare("SELECT COUNT(*) AS c FROM devices WHERE is_active=1").get().c;
    const total_packages = db.prepare("SELECT COUNT(*) AS c FROM packages WHERE is_active=1").get().c;
    const pending_jobs   = db.prepare("SELECT COUNT(*) AS c FROM update_jobs WHERE status NOT IN ('success','failed','rolled_back')").get().c;
    const failed_jobs    = db.prepare("SELECT COUNT(*) AS c FROM update_jobs WHERE status='failed'").get().c;
    const success_jobs   = db.prepare("SELECT COUNT(*) AS c FROM update_jobs WHERE status='success'").get().c;
    return reply.send({ total_devices, total_packages, pending_jobs, failed_jobs, success_jobs });
  });
}

module.exports = adminRoutes;

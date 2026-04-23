'use strict';
require('dotenv').config();
const Fastify = require('fastify');
const grpc = require('@grpc/grpc-js');
const { initSchema } = require('./src/db');
const { loadOrGenerateCert } = require('./src/utils');
const { createGrpcServer } = require('./src/grpc-server');

const PORT      = parseInt(process.env.PORT      || '8443');
const GRPC_PORT = parseInt(process.env.GRPC_PORT || '50051');
const CERT_PATH = process.env.TLS_CERT || './certs/server.crt';
const KEY_PATH  = process.env.TLS_KEY  || './certs/server.key';

async function start() {
  // Init DB schema
  initSchema();

  // TLS cert (auto-generated self-signed if absent)
  const { cert, key } = loadOrGenerateCert(CERT_PATH, KEY_PATH);

  // ── Fastify HTTP/2 server ────────────────────────────────────────────────────
  const app = Fastify({
    http2: true,
    https: { cert, key },
    logger: { level: process.env.LOG_LEVEL || 'info' }
  });

  await app.register(require('@fastify/multipart'), {
    limits: {
      fileSize: parseInt(process.env.MAX_PACKAGE_SIZE_MB || '500') * 1024 * 1024
    }
  });

  await app.register(require('./src/routes/devices'));
  await app.register(require('./src/routes/packages'));
  await app.register(require('./src/routes/updates'));
  await app.register(require('./src/routes/admin'));

  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`OTA HTTP/2 server → https://0.0.0.0:${PORT}`);

  // ── gRPC server ──────────────────────────────────────────────────────────────
  const grpcServer = createGrpcServer();
  await new Promise((resolve, reject) => {
    grpcServer.bindAsync(
      `0.0.0.0:${GRPC_PORT}`,
      grpc.ServerCredentials.createInsecure(),
      (err) => {
        if (err) return reject(err);
        grpcServer.start();
        app.log.info(`OTA gRPC server     → grpc://0.0.0.0:${GRPC_PORT}`);
        resolve();
      }
    );
  });
}

start().catch(err => {
  console.error('Fatal error starting OTA server:', err.message);
  process.exit(1);
});

import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { webhookRouter } from './whatsapp/webhook.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const IS_PROD = process.env.NODE_ENV === 'production';

// ── Fail-fast configuration check ─────────────────────────────────────────────

const REQUIRED_ENV = [
  'GROQ_API_KEY',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
];

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  if (IS_PROD) {
    console.error(`[Config] Missing required env vars: ${missing.join(', ')} — refusing to start`);
    process.exit(1);
  }
  console.warn(`[Config] Missing env vars: ${missing.join(', ')}`);
  console.warn('[Config] Copy .env.example to .env and fill in your values');
}

if (!process.env.WHATSAPP_APP_SECRET) {
  if (IS_PROD) {
    console.error(
      '[Config] WHATSAPP_APP_SECRET not set — webhook signature verification would be disabled. Refusing to start in production.'
    );
    process.exit(1);
  }
  console.warn(
    '[Config] WHATSAPP_APP_SECRET not set — webhook signature verification is DISABLED (dev only)'
  );
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();

// Capture the raw body so the webhook can verify Meta's HMAC signature
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  })
);

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'shopping-aggregator-whatsapp-agent',
    uptimeSeconds: Math.round(process.uptime()),
    mockData: process.env.USE_MOCK_DATA === 'true',
  });
});

// WhatsApp webhook
app.use('/webhook', webhookRouter);

const server = app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║   Shopping Aggregator — WhatsApp Agent                   ║
║   Powered by Groq LLM + MCP                              ║
╠══════════════════════════════════════════════════════════╣
║   Server:    http://localhost:${PORT}                       ║
║   Webhook:   http://localhost:${PORT}/webhook               ║
║   Health:    http://localhost:${PORT}/health                ║
╠══════════════════════════════════════════════════════════╣
║   Platforms: Amazon | Flipkart | Myntra                  ║
║              Meesho | Nykaa | Ajio                       ║
╚══════════════════════════════════════════════════════════╝
  `);
  if (missing.length === 0) {
    console.log('[Config] All required environment variables are set');
  }
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  console.log(`[Server] ${signal} received — shutting down gracefully`);
  server.close(() => {
    console.log('[Server] Closed');
    process.exit(0);
  });
  // Force-exit if connections don't drain in time
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

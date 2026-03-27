import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { webhookRouter } from './whatsapp/webhook.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

const app = express();
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'shopping-aggregator-whatsapp-agent' });
});

// WhatsApp webhook
app.use('/webhook', webhookRouter);

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║   Shopping Aggregator — WhatsApp Agent           ║
║   Powered by Claude AI + MCP                     ║
╠══════════════════════════════════════════════════╣
║   Server:    http://localhost:${PORT}               ║
║   Webhook:   http://localhost:${PORT}/webhook       ║
║   Health:    http://localhost:${PORT}/health        ║
╠══════════════════════════════════════════════════╣
║   Platforms: Amazon | Flipkart | Myntra          ║
╚══════════════════════════════════════════════════╝
  `);

  // Validate required env vars
  const required = [
    'GROQ_API_KEY',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.warn(`[Config] Missing env vars: ${missing.join(', ')}`);
    console.warn('[Config] Copy .env.example to .env and fill in your values');
  } else {
    console.log('[Config] All required environment variables are set');
  }
});

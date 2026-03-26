import { Router, Request, Response } from 'express';
import { processMessage } from '../agent/claudeAgent.js';
import { sendTextMessage, markAsRead } from './client.js';

export const webhookRouter = Router();

// GET /webhook — Meta webhook verification challenge
webhookRouter.get('/', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    console.log('[Webhook] Verification successful');
    res.status(200).send(challenge);
  } else {
    console.warn('[Webhook] Verification failed — token mismatch');
    res.sendStatus(403);
  }
});

// POST /webhook — Incoming WhatsApp messages
webhookRouter.post('/', async (req: Request, res: Response) => {
  // Respond 200 immediately so Meta doesn't retry
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value?.messages) continue;

        for (const message of value.messages) {
          if (message.type !== 'text') continue;

          const from: string = message.from;
          const messageId: string = message.id;
          const text: string = message.text?.body ?? '';

          if (!text.trim()) continue;

          console.log(`[Webhook] Message from ${from}: ${text}`);

          // Mark message as read
          await markAsRead(messageId);

          // Process through Claude agent
          const reply = await processMessage(from, text);

          // Send reply back to user
          await sendTextMessage(from, reply);
          console.log(`[Webhook] Replied to ${from}`);
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Error processing message:', err);
  }
});

import { Router, Request, Response } from 'express';
import { processMessage } from '../agent/claudeAgent.js';
import { sendTextMessage, markAsRead } from './client.js';
import { sendOrderSummary, sendCheckoutLink } from './interactiveMessages.js';
import { getBuyLink } from '../mcp/tools/getBuyLink.js';
import {
  getSearchResults,
  getBuyIntent,
  setBuyIntent,
  clearBuyIntent,
  addToWishlist,
} from '../agent/sessionManager.js';

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
          const from: string = message.from;
          const messageId: string = message.id;

          await markAsRead(messageId);

          // ── Interactive reply (button or list tap) ─────────────────────────
          if (message.type === 'interactive') {
            const interactive = message.interactive;
            const buttonId: string =
              interactive?.button_reply?.id ??
              interactive?.list_reply?.id ??
              '';

            console.log(`[Webhook] Interactive from ${from}: ${buttonId}`);
            await handleInteractive(from, buttonId);
            continue;
          }

          // ── Plain text message ─────────────────────────────────────────────
          if (message.type !== 'text') continue;

          const text: string = message.text?.body ?? '';
          if (!text.trim()) continue;

          console.log(`[Webhook] Message from ${from}: ${text}`);

          // Check if we're mid-buy-flow (collecting address/phone)
          const intent = getBuyIntent(from);
          if (intent) {
            await handleBuyFlowText(from, text, intent);
            continue;
          }

          // Normal agent processing
          const reply = await processMessage(from, text);
          await sendTextMessage(from, reply);
          console.log(`[Webhook] Replied to ${from}`);
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Error processing message:', err);
  }
});

// ── Interactive button/list handler ───────────────────────────────────────────

async function handleInteractive(from: string, buttonId: string): Promise<void> {
  try {
    // ID format: action__index__productId__platform
    const parts = buttonId.split('__');
    const action = parts[0];

    if (action === 'buy' || action === 'select') {
      // buy__index__productId__platform  OR  select__index__productId__platform
      const productId = parts[2];
      const platform = parts[3];

      if (!productId || !platform) {
        await sendTextMessage(from, 'Sorry, I lost track of that product. Please search again.');
        return;
      }

      // Fetch checkout URL
      const linkResult = await getBuyLink(productId, platform);

      // Start the buy flow — collect delivery address first
      setBuyIntent(from, {
        product: {
          id: linkResult.productId,
          platform: platform as 'amazon' | 'flipkart' | 'myntra',
          title: linkResult.title,
          price: linkResult.price,
          currency: 'INR',
          rating: 0,
          reviewCount: 0,
          imageUrl: linkResult.imageUrl,
          productUrl: linkResult.productUrl,
          specs: {},
        },
        checkoutUrl: linkResult.checkoutUrl,
        stage: 'awaiting_address',
      });

      const platformName = platform.charAt(0).toUpperCase() + platform.slice(1);
      const price = linkResult.price > 0 ? ` (₹${linkResult.price.toLocaleString('en-IN')})` : '';
      await sendTextMessage(
        from,
        `🛒 *Ready to buy from ${platformName}!*\n\n*${linkResult.title}*${price}\n\n📍 Please share your *delivery address* so I can include it in your order summary:`
      );
      return;
    }

    if (action === 'save') {
      // save__index__productId__platform — add to wishlist
      const productId = parts[2];
      const platform = parts[3];
      const products = getSearchResults(from);
      const product = products.find((p) => p.id === productId && p.platform === platform);
      if (product) {
        addToWishlist(from, product);
        await sendTextMessage(
          from,
          `❤️ *Saved to wishlist!*\n\n_${product.title}_\n\nType *wishlist* anytime to see all saved items.`
        );
      } else {
        await sendTextMessage(from, '❤️ Saved! Type *wishlist* to see your saved products.');
      }
      return;
    }

    if (action === 'compare') {
      const index = parts[1];
      const reply = await processMessage(from, `compare product ${index}`);
      await sendTextMessage(from, reply);
      return;
    }

    if (action === 'details') {
      const index = parts[1];
      const reply = await processMessage(from, `details for product ${index}`);
      await sendTextMessage(from, reply);
      return;
    }

    if (action === 'open') {
      // open__productId__platform — user tapped "Open Checkout"
      await sendTextMessage(
        from,
        '✅ Redirecting you to checkout! Complete your purchase on the platform and your order will be confirmed there.'
      );
      clearBuyIntent(from);
      return;
    }

    if (action === 'newSearch') {
      clearBuyIntent(from);
      const reply = await processMessage(from, 'I want to search for something else');
      await sendTextMessage(from, reply);
      return;
    }

    // Unknown button — fall through to agent
    const reply = await processMessage(from, buttonId.replace(/__/g, ' '));
    await sendTextMessage(from, reply);
  } catch (err) {
    console.error('[Webhook] handleInteractive error:', err);
    await sendTextMessage(from, 'Something went wrong. Please try again.');
  }
}

// ── Buy-flow text handler (collecting address → phone) ────────────────────────

async function handleBuyFlowText(
  from: string,
  text: string,
  intent: ReturnType<typeof getBuyIntent> & object
): Promise<void> {
  try {
    if (intent.stage === 'awaiting_address') {
      // Save address, ask for phone
      setBuyIntent(from, { ...intent, stage: 'awaiting_phone', address: text.trim() });
      await sendTextMessage(
        from,
        '📱 Got it! Now please share your *mobile number* for delivery updates:'
      );
      return;
    }

    if (intent.stage === 'awaiting_phone') {
      const phone = text.trim();
      const address = intent.address ?? '';

      // Show full order summary then checkout link
      await sendOrderSummary(from, intent.product, intent.checkoutUrl, address, phone);

      // Brief pause then send the interactive checkout button
      await sendCheckoutLink(from, intent.product, intent.checkoutUrl);

      // Mark as confirmed and clear
      clearBuyIntent(from);
      return;
    }
  } catch (err) {
    console.error('[Webhook] handleBuyFlowText error:', err);
    clearBuyIntent(from);
    await sendTextMessage(from, 'Something went wrong with your order. Please try again.');
  }
}

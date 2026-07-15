import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { processMessage, AgentReply } from '../agent/claudeAgent.js';
import { sendTextMessage, markAsRead } from './client.js';
import { sendOrderSummary, sendCheckoutLink, sendProductCard } from './interactiveMessages.js';
import { formatSearchResults } from './messageFormatter.js';
import { getBuyLink } from '../mcp/tools/getBuyLink.js';
import { Platform, Product } from '../types/index.js';
import {
  getSearchResults,
  getBuyIntent,
  setBuyIntent,
  clearBuyIntent,
  addToWishlist,
} from '../agent/sessionManager.js';

export const webhookRouter = Router();

// ── Security: verify Meta's X-Hub-Signature-256 HMAC ─────────────────────────
// Requires WHATSAPP_APP_SECRET (Meta App Dashboard → Settings → Basic).
// If unset, verification is skipped — index.ts refuses to start in production.

function verifySignature(req: Request): boolean {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) return true;

  const signature = req.header('x-hub-signature-256') ?? '';
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!signature || !rawBody) return false;

  const expected =
    'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false; // length mismatch
  }
}

// ── Reliability: dedupe Meta's webhook redeliveries ───────────────────────────

const DEDUP_TTL_MS = 10 * 60 * 1000;
const MAX_DEDUP_ENTRIES = 5000;
const processedMessages = new Map<string, number>();

function isDuplicate(messageId: string): boolean {
  const now = Date.now();
  if (processedMessages.has(messageId)) return true;
  processedMessages.set(messageId, now);
  if (processedMessages.size > MAX_DEDUP_ENTRIES) {
    for (const [id, ts] of processedMessages) {
      if (now - ts > DEDUP_TTL_MS) processedMessages.delete(id);
    }
  }
  return false;
}

// ── Abuse protection: per-user sliding-window rate limit ─────────────────────

const RATE_LIMIT = 10; // messages per window
const RATE_WINDOW_MS = 60 * 1000;
const userTimestamps = new Map<string, number[]>();

// Returns how many messages this user has sent within the current window
function recordMessage(userId: string): number {
  const now = Date.now();
  const recent = (userTimestamps.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  userTimestamps.set(userId, recent);
  return recent.length;
}

// ── Consistency: serialize processing per user ────────────────────────────────
// Two rapid messages from the same user must not interleave session state.

const userQueues = new Map<string, Promise<void>>();

function enqueueForUser(userId: string, task: () => Promise<void>): void {
  const prev = userQueues.get(userId) ?? Promise.resolve();
  const next = prev.then(task).catch((err) => {
    console.error(`[Webhook] Task failed for ${userId}:`, err);
  });
  userQueues.set(userId, next);
  void next.finally(() => {
    if (userQueues.get(userId) === next) userQueues.delete(userId);
  });
}

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
webhookRouter.post('/', (req: Request, res: Response) => {
  if (!verifySignature(req)) {
    console.warn('[Webhook] Signature verification failed — rejecting request');
    res.sendStatus(403);
    return;
  }

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
          if (!from || !messageId) continue;

          if (isDuplicate(messageId)) {
            console.log(`[Webhook] Skipping duplicate delivery of ${messageId}`);
            continue;
          }

          const count = recordMessage(from);
          if (count > RATE_LIMIT) {
            // Warn once when the limit is first crossed, then drop silently
            if (count === RATE_LIMIT + 1) {
              sendTextMessage(
                from,
                "⏳ You're sending messages a bit fast — give me a few seconds to catch up!"
              ).catch(() => { /* best effort */ });
            }
            continue;
          }

          enqueueForUser(from, () => handleMessage(from, messageId, message));
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Error processing payload:', err);
  }
});

// ── Single-message handler (runs serialized per user) ─────────────────────────

async function handleMessage(
  from: string,
  messageId: string,
  message: { type?: string; interactive?: { button_reply?: { id?: string }; list_reply?: { id?: string } }; text?: { body?: string } }
): Promise<void> {
  await markAsRead(messageId);

  // ── Interactive reply (button or list tap) ──────────────────────────────────
  if (message.type === 'interactive') {
    const interactive = message.interactive;
    const buttonId: string =
      interactive?.button_reply?.id ??
      interactive?.list_reply?.id ??
      '';

    console.log(`[Webhook] Interactive from ${from}: ${buttonId}`);
    await handleInteractive(from, buttonId);
    return;
  }

  // ── Plain text message ───────────────────────────────────────────────────────
  if (message.type !== 'text') return;

  const text: string = message.text?.body ?? '';
  if (!text.trim()) return;

  console.log(`[Webhook] Message from ${from}: ${text}`);

  // Check if we're mid-buy-flow (collecting address/phone)
  const intent = getBuyIntent(from);
  if (intent) {
    await handleBuyFlowText(from, text, intent);
    return;
  }

  // Normal agent processing
  const reply = await processMessage(from, text);
  await deliverAgentReply(from, reply);
  console.log(`[Webhook] Replied to ${from}`);
}

// ── Rich reply delivery ────────────────────────────────────────────────────────
// When the agent ran a product search, render the results deterministically:
// formatted list (badges, discounts, numbering) + tappable product cards with
// Buy buttons — instead of trusting the LLM to write out a readable list.

async function deliverAgentReply(to: string, reply: AgentReply): Promise<void> {
  const search = reply.search;
  if (!search || search.results.length === 0) {
    if (reply.text) await sendTextMessage(to, reply.text);
    return;
  }

  const { text: resultsText, allProducts } = formatSearchResults(
    search.results,
    1,
    search.cheapestPlatform,
    search.bestValuePlatform
  );
  await sendTextMessage(to, resultsText);

  // Product cards for the top picks (best value, cheapest, plus one more)
  for (const { product, index } of pickTopProducts(allProducts, search)) {
    try {
      await sendProductCard(to, product, index);
    } catch (err) {
      console.error('[Webhook] Product card send failed:', err);
      break;
    }
  }

  if (reply.text) await sendTextMessage(to, reply.text);
}

function pickTopProducts(
  allProducts: Product[],
  search: { cheapestPlatform?: string; bestValuePlatform?: string }
): Array<{ product: Product; index: number }> {
  const picks: Product[] = [];
  const addFirstOf = (platform?: string) => {
    if (!platform) return;
    const p = allProducts.find((x) => x.platform === platform);
    if (p && !picks.includes(p)) picks.push(p);
  };

  addFirstOf(search.bestValuePlatform);
  addFirstOf(search.cheapestPlatform);
  for (const p of allProducts) {
    if (picks.length >= 3) break;
    if (!picks.includes(p) && !picks.some((x) => x.platform === p.platform)) picks.push(p);
  }

  // index = the product's number in the formatted list, so cards and list agree
  return picks.map((product) => ({ product, index: allProducts.indexOf(product) + 1 }));
}

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
          platform: platform as Platform,
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
      await deliverAgentReply(from, reply);
      return;
    }

    if (action === 'details') {
      const index = parts[1];
      const reply = await processMessage(from, `details for product ${index}`);
      await deliverAgentReply(from, reply);
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
      await deliverAgentReply(from, reply);
      return;
    }

    // Unknown button — fall through to agent
    const reply = await processMessage(from, buttonId.replace(/__/g, ' '));
    await deliverAgentReply(from, reply);
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

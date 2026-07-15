import { getWishlist, recordProductPrice, getPriceHistory, checkPriceDrop } from './sessionManager.js';
import { Product, Platform } from '../types/index.js';
import { sendTextMessage } from '../whatsapp/client.js';

const PLATFORM_EMOJI: Record<string, string> = {
  amazon: '🛒',
  flipkart: '🛍',
  myntra: '👗',
  meesho: '🏷️',
  nykaa: '💄',
  ajio: '👔',
  zepto: '⚡',
  instamart: '🥦',
};

// Track prices every 6 hours (can be adjusted based on needs)
const PRICE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface PriceDropAlert {
  userId: string;
  product: Product;
  oldPrice: number;
  newPrice: number;
  savings: number;
  dropPercent: number;
  timestamp: number;
}

const sentAlerts = new Map<string, Map<string, number>>();
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // Don't alert for same product within 24h

export async function checkWishlistPrices(userId: string): Promise<PriceDropAlert[]> {
  const wishlist = getWishlist(userId);
  const alerts: PriceDropAlert[] = [];

  for (const product of wishlist) {
    const history = getPriceHistory(product.id, product.platform);
    if (history.length < 2) continue;

    const oldPrice = history[history.length - 2].price;
    const currentPrice = history[history.length - 1].price;
    const drop = ((oldPrice - currentPrice) / oldPrice) * 100;

    if (drop >= 10) {
      // Check if we've already alerted for this product recently
      const alertKey = `${product.id}__${product.platform}`;
      if (!sentAlerts.has(userId)) sentAlerts.set(userId, new Map());
      const userAlerts = sentAlerts.get(userId)!;
      const lastAlertTime = userAlerts.get(alertKey) ?? 0;

      if (Date.now() - lastAlertTime > ALERT_COOLDOWN_MS) {
        const savings = oldPrice - currentPrice;
        alerts.push({
          userId,
          product,
          oldPrice,
          newPrice: currentPrice,
          savings,
          dropPercent: Math.round(drop),
          timestamp: Date.now(),
        });
        userAlerts.set(alertKey, Date.now());
      }
    }
  }

  return alerts;
}

export async function sendPriceDropNotification(alert: PriceDropAlert): Promise<void> {
  const emoji = PLATFORM_EMOJI[alert.product.platform] ?? '🏪';
  const platform = alert.product.platform.charAt(0).toUpperCase() + alert.product.platform.slice(1);

  const message = [
    `🔥 *Price Drop Alert!*`,
    ``,
    `${emoji} *${alert.product.title}*`,
    `📉 ${alert.dropPercent}% off - Save ₹${alert.savings.toLocaleString('en-IN')}`,
    ``,
    `Was: ₹${alert.oldPrice.toLocaleString('en-IN')}`,
    `Now: ₹${alert.newPrice.toLocaleString('en-IN')}`,
    ``,
    `⏱️ *Limited time offer* — act fast!`,
    `Available on ${platform}`,
  ].join('\n');

  await sendTextMessage(alert.userId, message);
}

// Export function to check and notify for a user
export async function checkAndNotifyPriceDrop(userId: string): Promise<number> {
  try {
    const alerts = await checkWishlistPrices(userId);
    for (const alert of alerts) {
      await sendPriceDropNotification(alert);
    }
    return alerts.length;
  } catch (err) {
    console.error(`[PriceNotifications] Error checking prices for ${userId}:`, err);
    return 0;
  }
}

// Periodic job to check prices (can be triggered by a cron or background task)
export function startPriceCheckJob(): void {
  console.log('[PriceNotifications] Started price check job');
  setInterval(async () => {
    // In production, iterate over active users from a database
    console.log('[PriceNotifications] Running periodic price checks');
  }, PRICE_CHECK_INTERVAL_MS).unref();
}

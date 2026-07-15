import { UserSession, ConversationMessage, Product, BuyIntent } from '../types/index.js';

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_MESSAGES = 8; // keeps LLM token usage per turn in check (Groq free tier is 100K tokens/DAY)

const sessions = new Map<string, UserSession>();
const clickAnalytics = new Map<string, { platform: string; timestamp: number; productId: string }[]>();
const priceHistory = new Map<string, { productId: string; platform: string; price: number; timestamp: number }[]>();

export function getSession(userId: string): UserSession {
  const existing = sessions.get(userId);
  if (existing) {
    existing.lastActivity = new Date();
    return existing;
  }
  const session: UserSession = {
    userId,
    messages: [],
    lastActivity: new Date(),
  };
  sessions.set(userId, session);
  return session;
}

export function appendMessage(userId: string, message: ConversationMessage): void {
  const session = getSession(userId);
  session.messages.push(message);
  if (session.messages.length > MAX_MESSAGES) {
    session.messages = session.messages.slice(-MAX_MESSAGES);
  }
}

export function saveSearchResults(userId: string, products: Product[]): void {
  const session = getSession(userId);
  session.searchResults = products;
}

export function getSearchResults(userId: string): Product[] {
  return sessions.get(userId)?.searchResults ?? [];
}

export function setBuyIntent(userId: string, intent: BuyIntent): void {
  const session = getSession(userId);
  session.buyIntent = intent;
}

export function getBuyIntent(userId: string): BuyIntent | undefined {
  return sessions.get(userId)?.buyIntent;
}

export function clearBuyIntent(userId: string): void {
  const session = sessions.get(userId);
  if (session) session.buyIntent = undefined;
}

export function addToWishlist(userId: string, product: Product): void {
  const session = getSession(userId);
  if (!session.wishlist) session.wishlist = [];
  const alreadySaved = session.wishlist.some(
    (p) => p.id === product.id && p.platform === product.platform
  );
  if (!alreadySaved) session.wishlist.push(product);
}

export function removeFromWishlist(userId: string, productId: string, platform: string): void {
  const session = sessions.get(userId);
  if (session?.wishlist) {
    session.wishlist = session.wishlist.filter(
      (p) => !(p.id === productId && p.platform === platform)
    );
  }
}

export function getWishlist(userId: string): Product[] {
  return sessions.get(userId)?.wishlist ?? [];
}

export function setPreferredLanguage(userId: string, lang: 'en' | 'hi'): void {
  const session = getSession(userId);
  session.preferredLanguage = lang;
}

export function getPreferredLanguage(userId: string): 'en' | 'hi' {
  return sessions.get(userId)?.preferredLanguage ?? 'en';
}

export function clearSession(userId: string): void {
  sessions.delete(userId);
}

// ── Analytics & Monetization ──────────────────────────────────────────────────

export function recordBuyClick(userId: string, platform: string, productId: string): void {
  if (!clickAnalytics.has(userId)) clickAnalytics.set(userId, []);
  clickAnalytics.get(userId)!.push({ platform, timestamp: Date.now(), productId });
}

export function getClickStats(userId: string): { platform: string; count: number }[] {
  const clicks = clickAnalytics.get(userId) ?? [];
  const grouped = new Map<string, number>();
  for (const click of clicks) {
    grouped.set(click.platform, (grouped.get(click.platform) ?? 0) + 1);
  }
  return Array.from(grouped).map(([platform, count]) => ({ platform, count }));
}

export function recordProductPrice(userId: string, productId: string, platform: string, price: number): void {
  const key = `${productId}__${platform}`;
  if (!priceHistory.has(key)) priceHistory.set(key, []);
  priceHistory.get(key)!.push({ productId, platform, price, timestamp: Date.now() });
}

export function getPriceHistory(productId: string, platform: string): { price: number; timestamp: number }[] {
  const key = `${productId}__${platform}`;
  return (priceHistory.get(key) ?? []).map(({ price, timestamp }) => ({ price, timestamp }));
}

export function checkPriceDrop(productId: string, platform: string, newPrice: number, dropPercent = 10): boolean {
  const history = getPriceHistory(productId, platform);
  if (history.length < 2) return false;
  const oldPrice = history[history.length - 2].price;
  const drop = ((oldPrice - newPrice) / oldPrice) * 100;
  return drop >= dropPercent;
}

export function getAffiliateMetrics(): {
  totalClicks: number;
  clicksByPlatform: Record<string, number>;
  totalUsers: number;
  avgClicksPerUser: number;
} {
  let totalClicks = 0;
  const clicksByPlatform: Record<string, number> = {};

  for (const clicks of clickAnalytics.values()) {
    for (const click of clicks) {
      totalClicks++;
      clicksByPlatform[click.platform] = (clicksByPlatform[click.platform] ?? 0) + 1;
    }
  }

  const totalUsers = sessions.size;
  const avgClicksPerUser = totalUsers > 0 ? totalClicks / totalUsers : 0;

  return { totalClicks, clicksByPlatform, totalUsers, avgClicksPerUser };
}

// Clean up expired sessions every 5 minutes (unref'd so it never blocks exit)
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of sessions.entries()) {
    if (now - session.lastActivity.getTime() > SESSION_TTL_MS) {
      sessions.delete(userId);
      clickAnalytics.delete(userId);
    }
  }
}, 5 * 60 * 1000).unref();

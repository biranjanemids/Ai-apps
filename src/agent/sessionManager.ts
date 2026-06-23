import { UserSession, ConversationMessage, Product, BuyIntent } from '../types/index.js';

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_MESSAGES = 20;

const sessions = new Map<string, UserSession>();

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

// Clean up expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of sessions.entries()) {
    if (now - session.lastActivity.getTime() > SESSION_TTL_MS) {
      sessions.delete(userId);
    }
  }
}, 5 * 60 * 1000);

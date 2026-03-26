import { UserSession, ConversationMessage, Product } from '../types/index.js';

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

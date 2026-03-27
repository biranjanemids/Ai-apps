import { Product } from '../types/index.js';

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface CacheEntry {
  products: Product[];
  cachedAt: number;
}

const store = new Map<string, CacheEntry>();

export function cacheKey(
  platform: string,
  query: string,
  minPrice?: number,
  maxPrice?: number
): string {
  return `${platform}|${query.toLowerCase().trim()}|${minPrice ?? ''}|${maxPrice ?? ''}`;
}

export function getCache(key: string): Product[] | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    store.delete(key);
    return null;
  }
  return entry.products;
}

export function setCache(key: string, products: Product[]): void {
  store.set(key, { products, cachedAt: Date.now() });
}

export function cacheStats(): { entries: number; oldestMs: number } {
  const now = Date.now();
  let oldestMs = 0;
  for (const entry of store.values()) {
    const age = now - entry.cachedAt;
    if (age > oldestMs) oldestMs = age;
  }
  return { entries: store.size, oldestMs };
}

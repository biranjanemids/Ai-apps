import { Product } from '../types/index.js';

// Registry for products fetched from live aggregated sources (e.g. SerpApi).
// Those products have synthetic IDs that platform adapters can't re-fetch, so
// details / buy-link / compare lookups resolve from here first.

const TTL_MS = 60 * 60 * 1000; // 1 hour — outlives the 30-min session TTL
const MAX_ENTRIES = 2000;

interface Entry {
  product: Product;
  storedAt: number;
}

const registry = new Map<string, Entry>();

export function registerLiveProduct(product: Product): void {
  if (registry.size >= MAX_ENTRIES && !registry.has(product.id)) {
    const oldest = registry.keys().next().value;
    if (oldest !== undefined) registry.delete(oldest);
  }
  registry.set(product.id, { product, storedAt: Date.now() });
}

export function getLiveProduct(productId: string): Product | null {
  const entry = registry.get(productId);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > TTL_MS) {
    registry.delete(productId);
    return null;
  }
  return entry.product;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of registry.entries()) {
    if (now - entry.storedAt > TTL_MS) registry.delete(id);
  }
}, 10 * 60 * 1000).unref();

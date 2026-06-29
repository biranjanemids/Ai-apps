import { searchAmazon } from '../../platforms/amazon.js';
import { searchFlipkart } from '../../platforms/flipkart.js';
import { searchMyntra } from '../../platforms/myntra.js';
import { searchMeesho } from '../../platforms/meesho.js';
import { searchNykaa } from '../../platforms/nykaa.js';
import { searchAjio } from '../../platforms/ajio.js';
import { getCache, setCache, cacheKey } from '../../platforms/cache.js';
import { Product, SearchParams, Platform } from '../../types/index.js';

// Value score: balances rating quality vs price — higher is better deal
function valueScore(p: Product): number {
  if (p.price <= 0) return 0;
  const mrpStr = p.specs['MRP'] ?? p.specs['mrp'] ?? '';
  const mrp = parseFloat(mrpStr.replace(/[^0-9.]/g, '')) || p.price;
  const discountFactor = mrp > p.price ? (mrp - p.price) / mrp : 0;
  return ((p.rating * p.rating) / p.price) * 1000 * (1 + discountFactor);
}

export function discountPercent(product: Product): number {
  const mrpStr = product.specs['MRP'] ?? product.specs['mrp'] ?? '';
  const mrp = parseFloat(mrpStr.replace(/[^0-9.]/g, '')) || 0;
  if (mrp > product.price && mrp > 0) {
    return Math.round(((mrp - product.price) / mrp) * 100);
  }
  return 0;
}

export async function searchProducts(params: SearchParams): Promise<{
  results: Array<{ platform: string; products: Product[]; cached?: boolean; error?: string }>;
  totalFound: number;
  cheapestPlatform?: string;
  bestValuePlatform?: string;
}> {
  const platforms: Platform[] = params.platforms ?? ['amazon', 'flipkart', 'myntra', 'meesho', 'nykaa', 'ajio'];

  const platformSearches = [
    { name: 'amazon',   fn: () => searchAmazon(params) },
    { name: 'flipkart', fn: () => searchFlipkart(params) },
    { name: 'myntra',   fn: () => searchMyntra(params) },
    { name: 'meesho',   fn: () => searchMeesho(params) },
    { name: 'nykaa',    fn: () => searchNykaa(params) },
    { name: 'ajio',     fn: () => searchAjio(params) },
  ].filter((p) => platforms.includes(p.name as Platform));


  const searches = await Promise.allSettled(
    platformSearches.map(async ({ name, fn }) => {
      const key = cacheKey(name, params.query, params.minPrice, params.maxPrice);
      const cached = getCache(key);
      if (cached) return { products: cached, cached: true };
      const products = await fn();
      if (products.length > 0) setCache(key, products);
      return { products, cached: false };
    })
  );

  const results = searches.map((result, i) => {
    const name = platformSearches[i].name;
    if (result.status === 'fulfilled') {
      // Sort by value score (rating²/price * discount factor) — best deals first
      const sorted = result.value.products.sort((a, b) => valueScore(b) - valueScore(a));
      return { platform: name, products: sorted.slice(0, 5), cached: result.value.cached };
    }
    return {
      platform: name,
      products: [],
      error: result.reason instanceof Error ? result.reason.message : 'Search failed',
    };
  });

  // Cross-platform cheapest + best-value signals
  const allWithPrice = results.flatMap((r) => r.products.filter((p) => p.price > 0));
  const cheapest = allWithPrice.reduce<Product | null>(
    (min, p) => (!min || p.price < min.price ? p : min),
    null
  );
  const bestValue = allWithPrice.reduce<Product | null>(
    (best, p) => (!best || valueScore(p) > valueScore(best) ? p : best),
    null
  );

  const totalFound = results.reduce((sum, r) => sum + r.products.length, 0);
  return {
    results,
    totalFound,
    cheapestPlatform: cheapest?.platform,
    bestValuePlatform: bestValue?.platform,
  };
}


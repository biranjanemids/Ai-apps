import { searchAmazon } from '../../platforms/amazon.js';
import { searchFlipkart } from '../../platforms/flipkart.js';
import { searchMyntra } from '../../platforms/myntra.js';
import { getCache, setCache, cacheKey } from '../../platforms/cache.js';
import { Product, SearchParams } from '../../types/index.js';

export async function searchProducts(params: SearchParams): Promise<{
  results: Array<{ platform: string; products: Product[]; cached?: boolean; error?: string }>;
  totalFound: number;
}> {
  const platforms = params.platforms ?? ['amazon', 'flipkart', 'myntra'];

  // Per-platform search with cache check
  const platformSearches = [
    { name: 'amazon',   fn: () => searchAmazon(params) },
    { name: 'flipkart', fn: () => searchFlipkart(params) },
    { name: 'myntra',   fn: () => searchMyntra(params) },
  ].filter((p) => platforms.includes(p.name as 'amazon' | 'flipkart' | 'myntra'));

  const searches = await Promise.allSettled(
    platformSearches.map(async ({ name, fn }) => {
      const key = cacheKey(name, params.query, params.minPrice, params.maxPrice);
      const cached = getCache(key);
      if (cached) {
        return { products: cached, cached: true };
      }
      const products = await fn();
      if (products.length > 0) setCache(key, products);
      return { products, cached: false };
    })
  );

  const results = searches.map((result, i) => {
    const name = platformSearches[i].name;
    if (result.status === 'fulfilled') {
      const sorted = result.value.products.sort((a, b) => b.rating - a.rating);
      return {
        platform: name,
        products: sorted.slice(0, 5),
        cached: result.value.cached,
      };
    }
    return {
      platform: name,
      products: [],
      error: result.reason instanceof Error ? result.reason.message : 'Search failed',
    };
  });

  const totalFound = results.reduce((sum, r) => sum + r.products.length, 0);
  return { results, totalFound };
}

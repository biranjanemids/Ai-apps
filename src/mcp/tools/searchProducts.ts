import { searchAmazon } from '../../platforms/amazon.js';
import { searchFlipkart } from '../../platforms/flipkart.js';
import { searchMyntra } from '../../platforms/myntra.js';
import { Product, SearchParams } from '../../types/index.js';

export async function searchProducts(params: SearchParams): Promise<{
  results: Array<{ platform: string; products: Product[]; error?: string }>;
  totalFound: number;
}> {
  const platforms = params.platforms ?? ['amazon', 'flipkart', 'myntra'];

  const searches = await Promise.allSettled([
    platforms.includes('amazon') ? searchAmazon(params) : Promise.resolve([]),
    platforms.includes('flipkart') ? searchFlipkart(params) : Promise.resolve([]),
    platforms.includes('myntra') ? searchMyntra(params) : Promise.resolve([]),
  ]);

  const platformNames = ['amazon', 'flipkart', 'myntra'];
  const results = searches.map((result, i) => {
    if (result.status === 'fulfilled') {
      const sorted = result.value.sort((a, b) => b.rating - a.rating);
      return { platform: platformNames[i], products: sorted.slice(0, 5) };
    }
    return {
      platform: platformNames[i],
      products: [],
      error: result.reason instanceof Error ? result.reason.message : 'Search failed',
    };
  });

  const totalFound = results.reduce((sum, r) => sum + r.products.length, 0);
  return { results, totalFound };
}

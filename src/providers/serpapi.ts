import axios from 'axios';
import { Product, SearchParams, Platform } from '../types/index.js';
import { registerLiveProduct } from '../platforms/liveRegistry.js';

// SerpApi Google Shopping provider — real, authenticated product data for
// India across all major stores in a single API call.
//
// Setup: sign up at https://serpapi.com (free tier: 100 searches/month),
// copy your key into .env as SERPAPI_KEY. When the key is present and
// USE_MOCK_DATA is not 'true', this becomes the primary data source; the
// per-platform scrapers remain the fallback.

const SERPAPI_URL = 'https://serpapi.com/search.json';

export function isSerpApiEnabled(): boolean {
  return Boolean(process.env.SERPAPI_KEY) && process.env.USE_MOCK_DATA !== 'true';
}

interface SerpShoppingItem {
  position?: number;
  title?: string;
  link?: string;
  product_link?: string;
  source?: string;          // store name, e.g. "Amazon.in", "Flipkart"
  price?: string;           // display string, e.g. "₹1,299"
  extracted_price?: number;
  old_price?: string;
  extracted_old_price?: number;
  rating?: number;
  reviews?: number;
  thumbnail?: string;
  delivery?: string;
}

// Map a Google Shopping store name onto one of our platforms.
// Unknown stores are skipped so the platform union stays closed.
export function mapStoreToPlatform(source: string): Platform | null {
  const s = source.toLowerCase();
  if (s.includes('amazon')) return 'amazon';
  if (s.includes('flipkart')) return 'flipkart';
  if (s.includes('myntra')) return 'myntra';
  if (s.includes('meesho')) return 'meesho';
  if (s.includes('nykaa')) return 'nykaa';
  if (s.includes('ajio')) return 'ajio';
  if (s.includes('zepto')) return 'zepto';
  if (s.includes('swiggy') || s.includes('instamart')) return 'instamart';
  return null;
}

let serpIdCounter = 0;

// One Google Shopping search → products bucketed by platform.
// Every product is registered in the live registry so buy-link / details /
// compare can resolve the synthetic IDs later in the conversation.
export async function searchViaSerpApi(
  params: SearchParams
): Promise<Map<Platform, Product[]>> {
  const query: Record<string, string> = {
    engine: 'google_shopping',
    q: params.query,
    gl: 'in',
    hl: 'en',
    num: '40',
    api_key: process.env.SERPAPI_KEY ?? '',
  };
  // Native price filter (the aggregator enforces budget again afterwards)
  const priceParts = [
    params.minPrice !== undefined ? `ppr_min:${params.minPrice}` : '',
    params.maxPrice !== undefined ? `ppr_max:${params.maxPrice}` : '',
  ].filter(Boolean);
  if (priceParts.length > 0) query['tbs'] = `mr:1,price:1,${priceParts.join(',')}`;

  const { data } = await axios.get<{ shopping_results?: SerpShoppingItem[] }>(SERPAPI_URL, {
    params: query,
    timeout: 10_000,
  });

  const items = data?.shopping_results ?? [];
  const byPlatform = new Map<Platform, Product[]>();
  let skipped = 0;

  for (const item of items) {
    const platform = mapStoreToPlatform(item.source ?? '');
    if (!platform || !item.title) {
      skipped++;
      continue;
    }

    const productUrl = item.link ?? item.product_link ?? '';
    if (!productUrl) {
      skipped++;
      continue;
    }

    const specs: Record<string, string> = { Source: 'Live (Google Shopping)' };
    if (item.source) specs['Store'] = item.source;
    if (item.delivery) specs['Delivery'] = item.delivery;
    if (
      item.extracted_old_price !== undefined &&
      item.extracted_price !== undefined &&
      item.extracted_old_price > item.extracted_price
    ) {
      specs['MRP'] = `₹${item.extracted_old_price}`;
    }

    const product: Product = {
      id: `serp_${++serpIdCounter}_${item.position ?? 0}`,
      platform,
      title: item.title,
      price: item.extracted_price ?? 0,
      currency: 'INR',
      rating: item.rating ?? 0,
      reviewCount: item.reviews ?? 0,
      imageUrl: item.thumbnail ?? '',
      productUrl,
      specs,
    };

    registerLiveProduct(product);
    const bucket = byPlatform.get(platform) ?? [];
    bucket.push(product);
    byPlatform.set(platform, bucket);
  }

  console.log(
    `[SerpApi] ${items.length} results → ${[...byPlatform.entries()]
      .map(([p, list]) => `${p}:${list.length}`)
      .join(' ')}${skipped ? ` (${skipped} from other stores skipped)` : ''}`
  );
  return byPlatform;
}

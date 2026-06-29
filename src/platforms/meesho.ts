import axios from 'axios';
import { Product, SearchParams } from '../types/index.js';
import { getMockProducts, getMockProduct, randomUserAgent } from './mock.js';

const BASE = 'https://www.meesho.com';

function buildHeaders() {
  return {
    'User-Agent': randomUserAgent(),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8',
    'Content-Type': 'application/json',
    'Origin': 'https://www.meesho.com',
    'Referer': 'https://www.meesho.com/',
  };
}

interface MeeshoProduct {
  id?: number;
  name?: string;
  price?: { current_price?: number; mrp?: number };
  images?: Array<{ url?: string }>;
  catalog_name?: string;
  avg_rating?: number;
  rating_count?: number;
  slug?: string;
}

export async function searchMeesho(params: SearchParams): Promise<Product[]> {
  if (process.env.USE_MOCK_DATA === 'true') {
    return getMockProducts('meesho', params.query, params);
  }

  try {
    const payload = {
      query: params.query,
      page: 1,
      pageLimit: 10,
      filters: {
        ...(params.minPrice !== undefined && { price_min: params.minPrice }),
        ...(params.maxPrice !== undefined && { price_max: params.maxPrice }),
      },
    };

    const { data } = await axios.post<{ catalogs?: MeeshoProduct[] }>(
      `${BASE}/api/v1/search/`,
      payload,
      { headers: buildHeaders(), timeout: 5000 }
    );

    const catalogs = data?.catalogs ?? [];
    const products: Product[] = catalogs.slice(0, 5).map((item) => {
      const price = item.price?.current_price ?? 0;
      const mrp = item.price?.mrp ?? 0;
      const slug = item.slug ?? String(item.id ?? '');
      const productUrl = `${BASE}/${slug}/p/${item.id ?? ''}`;
      const specs: Record<string, string> = {};
      if (mrp > price) specs['MRP'] = `₹${mrp}`;
      return {
        id: String(item.id ?? slug),
        platform: 'meesho' as const,
        title: item.catalog_name ?? item.name ?? 'Unknown Product',
        price,
        currency: 'INR',
        rating: item.avg_rating ?? 0,
        reviewCount: item.rating_count ?? 0,
        imageUrl: item.images?.[0]?.url ?? '',
        productUrl,
        specs,
      };
    });

    if (products.length > 0) return products;

    console.warn('[Meesho] API returned 0 results — using mock fallback');
    return getMockProducts('meesho', params.query, params);
  } catch (err) {
    console.error('[Meesho] Search failed:', err instanceof Error ? err.message : err);
    return getMockProducts('meesho', params.query, params);
  }
}

export async function getMeeshoProduct(productId: string): Promise<Product | null> {
  if (process.env.USE_MOCK_DATA === 'true') {
    return getMockProduct('meesho', productId);
  }

  try {
    const { data } = await axios.get<{ catalog?: MeeshoProduct }>(
      `${BASE}/api/v1/catalog/${productId}/`,
      { headers: buildHeaders(), timeout: 5000 }
    );

    const item = data?.catalog;
    if (!item) return getMockProduct('meesho', productId);

    const price = item.price?.current_price ?? 0;
    const mrp = item.price?.mrp ?? 0;
    const slug = item.slug ?? productId;

    const specs: Record<string, string> = {};
    if (mrp > price) specs['MRP'] = `₹${mrp}`;
    return {
      id: productId,
      platform: 'meesho' as const,
      title: item.catalog_name ?? item.name ?? 'Unknown Product',
      price,
      currency: 'INR',
      rating: item.avg_rating ?? 0,
      reviewCount: item.rating_count ?? 0,
      imageUrl: item.images?.[0]?.url ?? '',
      productUrl: `${BASE}/${slug}/p/${productId}`,
      specs,
    };
  } catch (err) {
    console.error('[Meesho] Product detail failed:', err instanceof Error ? err.message : err);
    return getMockProduct('meesho', productId);
  }
}

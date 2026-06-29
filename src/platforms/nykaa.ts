import axios from 'axios';
import { Product, SearchParams } from '../types/index.js';
import { getMockProducts, getMockProduct, randomUserAgent } from './mock.js';

const BASE = 'https://www.nykaa.com';

function buildHeaders() {
  return {
    'User-Agent': randomUserAgent(),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en;q=0.9',
    'Origin': 'https://www.nykaa.com',
    'Referer': 'https://www.nykaa.com/',
    'x-location-context': 'pincode=400001;source=user',
  };
}

interface NykaaProduct {
  id?: number;
  name?: string;
  price?: number;
  mrp?: number;
  imageUrl?: string;
  slug?: string;
  averageRating?: number;
  numberOfRatings?: number;
  brand?: string;
  productType?: string;
}

interface NykaaResponse {
  response?: {
    products?: NykaaProduct[];
  };
}

export async function searchNykaa(params: SearchParams): Promise<Product[]> {
  if (process.env.USE_MOCK_DATA === 'true') {
    return getMockProducts('nykaa', params.query, params);
  }

  try {
    const queryParams = new URLSearchParams({
      q: params.query,
      limit: '10',
      ...(params.minPrice !== undefined && { price_min: String(params.minPrice) }),
      ...(params.maxPrice !== undefined && { price_max: String(params.maxPrice) }),
    });

    const { data } = await axios.get<NykaaResponse>(
      `${BASE}/api/product/search?${queryParams}`,
      { headers: buildHeaders(), timeout: 5000 }
    );

    const items = data?.response?.products ?? [];
    const products: Product[] = items.slice(0, 5).map((item) => {
      const price = item.price ?? 0;
      const mrp = item.mrp ?? 0;
      const slug = item.slug ?? String(item.id ?? '');
      const specs: Record<string, string> = {};
      if (item.brand) specs['Brand'] = item.brand;
      if (item.productType) specs['Category'] = item.productType;
      if (mrp > price) specs['MRP'] = `₹${mrp}`;
      return {
        id: String(item.id ?? slug),
        platform: 'nykaa' as const,
        title: item.name ?? 'Unknown Product',
        price,
        currency: 'INR',
        rating: item.averageRating ?? 0,
        reviewCount: item.numberOfRatings ?? 0,
        imageUrl: item.imageUrl ?? '',
        productUrl: `${BASE}/${slug}/p/${item.id}`,
        specs,
      };
    });

    if (products.length > 0) return products;

    console.warn('[Nykaa] API returned 0 results — using mock fallback');
    return getMockProducts('nykaa', params.query, params);
  } catch (err) {
    console.error('[Nykaa] Search failed:', err instanceof Error ? err.message : err);
    return getMockProducts('nykaa', params.query, params);
  }
}

export async function getNykaaProduct(productId: string): Promise<Product | null> {
  if (process.env.USE_MOCK_DATA === 'true') {
    return getMockProduct('nykaa', productId);
  }

  try {
    const { data } = await axios.get<{ response?: { product?: NykaaProduct } }>(
      `${BASE}/api/product/${productId}`,
      { headers: buildHeaders(), timeout: 5000 }
    );

    const item = data?.response?.product;
    if (!item) return getMockProduct('nykaa', productId);

    const price = item.price ?? 0;
    const mrp = item.mrp ?? 0;
    const slug = item.slug ?? productId;

    const specs: Record<string, string> = {};
    if (item.brand) specs['Brand'] = item.brand;
    if (item.productType) specs['Category'] = item.productType;
    if (mrp > price) specs['MRP'] = `₹${mrp}`;
    return {
      id: productId,
      platform: 'nykaa' as const,
      title: item.name ?? 'Unknown Product',
      price,
      currency: 'INR',
      rating: item.averageRating ?? 0,
      reviewCount: item.numberOfRatings ?? 0,
      imageUrl: item.imageUrl ?? '',
      productUrl: `${BASE}/${slug}/p/${productId}`,
      specs,
    };
  } catch (err) {
    console.error('[Nykaa] Product detail failed:', err instanceof Error ? err.message : err);
    return getMockProduct('nykaa', productId);
  }
}

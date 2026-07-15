import axios from 'axios';
import { Product, SearchParams } from '../types/index.js';
import { getMockProducts, getMockProduct, randomUserAgent } from './mock.js';

const BASE = 'https://www.swiggy.com';

function buildHeaders() {
  return {
    'User-Agent': randomUserAgent(),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en;q=0.9',
    'Origin': BASE,
    'Referer': `${BASE}/instamart`,
  };
}

interface InstamartItem {
  product_id?: string;
  display_name?: string;
  price?: { offer_price?: number; mrp?: number };
  images?: string[];
  brand?: string;
  rating?: { value?: number; count?: number };
  category?: string;
}

export async function searchInstamart(params: SearchParams): Promise<Product[]> {
  if (process.env.USE_MOCK_DATA === 'true') {
    return getMockProducts('instamart', params.query, params);
  }

  try {
    const { data } = await axios.get<{ data?: { items?: InstamartItem[] } }>(
      `${BASE}/api/instamart/search?custom_back=true&query=${encodeURIComponent(params.query)}`,
      { headers: buildHeaders(), timeout: 5000 }
    );

    const items = data?.data?.items ?? [];
    const products: Product[] = items.slice(0, 5).map((item) => {
      const price = item.price?.offer_price ?? 0;
      const mrp = item.price?.mrp ?? 0;
      const id = item.product_id ?? '';

      const specs: Record<string, string> = { Delivery: '15 min' };
      if (item.brand) specs['Brand'] = item.brand;
      if (item.category) specs['Category'] = item.category;
      if (mrp > price) specs['MRP'] = `₹${mrp}`;
      return {
        id,
        platform: 'instamart' as const,
        title: item.display_name ?? 'Unknown Product',
        price,
        currency: 'INR',
        rating: item.rating?.value ?? 0,
        reviewCount: item.rating?.count ?? 0,
        imageUrl: item.images?.[0] ? `https://instamart-media.swiggy.com/${item.images[0]}` : '',
        productUrl: `${BASE}/instamart/item/${id}`,
        specs,
      };
    });

    if (products.length > 0) return products;

    console.warn('[Instamart] API returned 0 results — using mock fallback');
    return getMockProducts('instamart', params.query, params);
  } catch (err) {
    console.error('[Instamart] Search failed:', err instanceof Error ? err.message : err);
    return getMockProducts('instamart', params.query, params);
  }
}

export async function getInstamartProduct(productId: string): Promise<Product | null> {
  if (process.env.USE_MOCK_DATA === 'true') {
    return getMockProduct('instamart', productId);
  }

  try {
    const { data } = await axios.get<{ data?: { item?: InstamartItem } }>(
      `${BASE}/api/instamart/item/${productId}`,
      { headers: buildHeaders(), timeout: 5000 }
    );

    const item = data?.data?.item;
    if (!item) return getMockProduct('instamart', productId);

    const price = item.price?.offer_price ?? 0;
    const mrp = item.price?.mrp ?? 0;

    const specs: Record<string, string> = { Delivery: '15 min' };
    if (item.brand) specs['Brand'] = item.brand;
    if (item.category) specs['Category'] = item.category;
    if (mrp > price) specs['MRP'] = `₹${mrp}`;
    return {
      id: productId,
      platform: 'instamart' as const,
      title: item.display_name ?? 'Unknown Product',
      price,
      currency: 'INR',
      rating: item.rating?.value ?? 0,
      reviewCount: item.rating?.count ?? 0,
      imageUrl: item.images?.[0] ? `https://instamart-media.swiggy.com/${item.images[0]}` : '',
      productUrl: `${BASE}/instamart/item/${productId}`,
      specs,
    };
  } catch (err) {
    console.error('[Instamart] Product detail failed:', err instanceof Error ? err.message : err);
    return getMockProduct('instamart', productId);
  }
}

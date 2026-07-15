import axios from 'axios';
import { Product, SearchParams } from '../types/index.js';
import { getMockProducts, getMockProduct, randomUserAgent } from './mock.js';

const BASE = 'https://www.zeptonow.com';
const API = 'https://api.zeptonow.com';

function buildHeaders() {
  return {
    'User-Agent': randomUserAgent(),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en;q=0.9',
    'Content-Type': 'application/json',
    'Origin': BASE,
    'Referer': `${BASE}/`,
  };
}

interface ZeptoProduct {
  id?: string;
  productVariantId?: string;
  name?: string;
  sellingPrice?: number;   // in paise
  mrp?: number;            // in paise
  image?: { path?: string };
  rating?: number;
  ratingCount?: number;
  brand?: string;
  slug?: string;
}

export async function searchZepto(params: SearchParams): Promise<Product[]> {
  if (process.env.USE_MOCK_DATA === 'true') {
    return getMockProducts('zepto', params.query, params);
  }

  try {
    const { data } = await axios.post<{ items?: Array<{ product?: ZeptoProduct }> }>(
      `${API}/api/v3/search`,
      { query: params.query, pageNumber: 0, intentId: '' },
      { headers: buildHeaders(), timeout: 5000 }
    );

    const items = (data?.items ?? []).map((i) => i.product).filter(Boolean) as ZeptoProduct[];
    const products: Product[] = items.slice(0, 5).map((item) => {
      // Zepto prices come in paise
      const price = Math.round((item.sellingPrice ?? 0) / 100);
      const mrp = Math.round((item.mrp ?? 0) / 100);
      const id = item.productVariantId ?? item.id ?? '';
      const slug = item.slug ?? id;

      const specs: Record<string, string> = { Delivery: '10 min' };
      if (item.brand) specs['Brand'] = item.brand;
      if (mrp > price) specs['MRP'] = `₹${mrp}`;
      return {
        id,
        platform: 'zepto' as const,
        title: item.name ?? 'Unknown Product',
        price,
        currency: 'INR',
        rating: item.rating ?? 0,
        reviewCount: item.ratingCount ?? 0,
        imageUrl: item.image?.path ? `https://cdn.zeptonow.com/production/${item.image.path}` : '',
        productUrl: `${BASE}/pn/${slug}/pvid/${id}`,
        specs,
      };
    });

    if (products.length > 0) return products;

    console.warn('[Zepto] API returned 0 results — using mock fallback');
    return getMockProducts('zepto', params.query, params);
  } catch (err) {
    console.error('[Zepto] Search failed:', err instanceof Error ? err.message : err);
    return getMockProducts('zepto', params.query, params);
  }
}

export async function getZeptoProduct(productId: string): Promise<Product | null> {
  if (process.env.USE_MOCK_DATA === 'true') {
    return getMockProduct('zepto', productId);
  }

  try {
    const { data } = await axios.get<{ product?: ZeptoProduct }>(
      `${API}/api/v1/product-variant/${productId}`,
      { headers: buildHeaders(), timeout: 5000 }
    );

    const item = data?.product;
    if (!item) return getMockProduct('zepto', productId);

    const price = Math.round((item.sellingPrice ?? 0) / 100);
    const mrp = Math.round((item.mrp ?? 0) / 100);
    const slug = item.slug ?? productId;

    const specs: Record<string, string> = { Delivery: '10 min' };
    if (item.brand) specs['Brand'] = item.brand;
    if (mrp > price) specs['MRP'] = `₹${mrp}`;
    return {
      id: productId,
      platform: 'zepto' as const,
      title: item.name ?? 'Unknown Product',
      price,
      currency: 'INR',
      rating: item.rating ?? 0,
      reviewCount: item.ratingCount ?? 0,
      imageUrl: item.image?.path ? `https://cdn.zeptonow.com/production/${item.image.path}` : '',
      productUrl: `${BASE}/pn/${slug}/pvid/${productId}`,
      specs,
    };
  } catch (err) {
    console.error('[Zepto] Product detail failed:', err instanceof Error ? err.message : err);
    return getMockProduct('zepto', productId);
  }
}

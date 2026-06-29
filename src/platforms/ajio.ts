import axios from 'axios';
import { Product, SearchParams } from '../types/index.js';
import { getMockProducts, getMockProduct, randomUserAgent } from './mock.js';

const BASE = 'https://www.ajio.com';

function buildHeaders() {
  return {
    'User-Agent': randomUserAgent(),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en;q=0.9',
    'Origin': 'https://www.ajio.com',
    'Referer': 'https://www.ajio.com/',
  };
}

interface AjioProduct {
  code?: string;
  name?: string;
  price?: { value?: number; formattedValue?: string };
  wasPriceData?: { value?: number; formattedValue?: string };
  images?: Array<{ url?: string; format?: string }>;
  averageRating?: number;
  noOfRatings?: number;
  fnlColorVariantData?: Array<{ brandName?: string }>;
  url?: string;
}

interface AjioResponse {
  products?: AjioProduct[];
  pagination?: { totalNumberOfResults?: number };
}

export async function searchAjio(params: SearchParams): Promise<Product[]> {
  if (process.env.USE_MOCK_DATA === 'true') {
    return getMockProducts('ajio', params.query, params);
  }

  try {
    const queryParams = new URLSearchParams({
      text: params.query,
      pageSize: '10',
      currentPage: '0',
      sortBy: 'relevance',
      format: 'json',
      ...(params.minPrice !== undefined && { price_min: String(params.minPrice) }),
      ...(params.maxPrice !== undefined && { price_max: String(params.maxPrice) }),
    });

    const { data } = await axios.get<AjioResponse>(
      `${BASE}/api/search?${queryParams}`,
      { headers: buildHeaders(), timeout: 5000 }
    );

    const items = data?.products ?? [];
    const products: Product[] = items.slice(0, 5).map((item) => {
      const price = item.price?.value ?? 0;
      const mrp = item.wasPriceData?.value ?? 0;
      const brand = item.fnlColorVariantData?.[0]?.brandName ?? '';
      const imageUrl = item.images?.find((img) => img.format === 'product')?.url
        ?? item.images?.[0]?.url
        ?? '';
      const relativeUrl = item.url ?? '';
      const productUrl = relativeUrl.startsWith('http') ? relativeUrl : `${BASE}${relativeUrl}`;
      const productId = item.code ?? relativeUrl.split('/').pop() ?? '';

      const specs: Record<string, string> = {};
      if (brand) specs['Brand'] = brand;
      if (mrp > price) specs['MRP'] = `₹${mrp}`;
      return {
        id: productId,
        platform: 'ajio' as const,
        title: item.name ?? 'Unknown Product',
        price,
        currency: 'INR',
        rating: item.averageRating ?? 0,
        reviewCount: item.noOfRatings ?? 0,
        imageUrl: imageUrl.startsWith('http') ? imageUrl : `${BASE}${imageUrl}`,
        productUrl,
        specs,
      };
    });

    if (products.length > 0) return products;

    console.warn('[Ajio] API returned 0 results — using mock fallback');
    return getMockProducts('ajio', params.query, params);
  } catch (err) {
    console.error('[Ajio] Search failed:', err instanceof Error ? err.message : err);
    return getMockProducts('ajio', params.query, params);
  }
}

export async function getAjioProduct(productId: string): Promise<Product | null> {
  if (process.env.USE_MOCK_DATA === 'true') {
    return getMockProduct('ajio', productId);
  }

  try {
    const { data } = await axios.get<{ product?: AjioProduct }>(
      `${BASE}/api/p/${productId}?format=json`,
      { headers: buildHeaders(), timeout: 5000 }
    );

    const item = data?.product;
    if (!item) return getMockProduct('ajio', productId);

    const price = item.price?.value ?? 0;
    const mrp = item.wasPriceData?.value ?? 0;
    const brand = item.fnlColorVariantData?.[0]?.brandName ?? '';
    const relativeUrl = item.url ?? '';
    const productUrl = relativeUrl.startsWith('http') ? relativeUrl : `${BASE}${relativeUrl}`;

    const specs: Record<string, string> = {};
    if (brand) specs['Brand'] = brand;
    if (mrp > price) specs['MRP'] = `₹${mrp}`;
    return {
      id: productId,
      platform: 'ajio' as const,
      title: item.name ?? 'Unknown Product',
      price,
      currency: 'INR',
      rating: item.averageRating ?? 0,
      reviewCount: item.noOfRatings ?? 0,
      imageUrl: item.images?.[0]?.url ?? '',
      productUrl,
      specs,
    };
  } catch (err) {
    console.error('[Ajio] Product detail failed:', err instanceof Error ? err.message : err);
    return getMockProduct('ajio', productId);
  }
}

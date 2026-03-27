import axios from 'axios';
import { Product, SearchParams } from '../types/index.js';
import { getMockProducts, getMockProduct, randomUserAgent } from './mock.js';

// Myntra's internal search gateway — no auth required
const GATEWAY_URL = 'https://www.myntra.com/gateway/v2/catalog/products/searchv2';

interface MyntraGatewayProduct {
  productId: number | string;
  productName?: string;
  name?: string;
  brand?: string;
  price?: { discounted?: number; marked?: number };
  discountedPrice?: number;
  mrp?: number;
  rating?: number;
  ratingCount?: number;
  images?: Array<{ secureSrc?: string; src?: string }>;
  landingPageUrl?: string;
  gender?: string;
  primaryType?: string;
  category?: string;
}

interface MyntraGatewayResponse {
  searchData?: {
    results?: {
      products?: MyntraGatewayProduct[];
    };
  };
  // older response shape
  products?: MyntraGatewayProduct[];
}

function buildHeaders() {
  return {
    'User-Agent': randomUserAgent(),
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en;q=0.9',
    Referer: 'https://www.myntra.com/',
    'x-location-code': 'undefined',
    'x-myntra-abtest': 'true',
    Connection: 'keep-alive',
  };
}

function normaliseProduct(item: MyntraGatewayProduct): Product {
  const productId = String(item.productId);
  const title = item.productName ?? item.name ?? 'Unknown';
  const price = item.price?.discounted ?? item.discountedPrice ?? item.mrp ?? 0;
  const mrp = item.price?.marked ?? item.mrp;
  const imageUrl = item.images?.[0]?.secureSrc ?? item.images?.[0]?.src ?? '';
  const landingPath = item.landingPageUrl ?? '';
  const productUrl = landingPath.startsWith('http')
    ? landingPath
    : `https://www.myntra.com/${landingPath || productId}`;

  const specs: Record<string, string> = {};
  if (item.brand) specs['Brand'] = item.brand;
  if (mrp) specs['MRP'] = `₹${mrp}`;
  if (item.gender) specs['Gender'] = item.gender;
  if (item.primaryType ?? item.category) specs['Category'] = (item.primaryType ?? item.category)!;

  return {
    id: productId,
    platform: 'myntra',
    title,
    price,
    currency: 'INR',
    rating: item.rating ?? 0,
    reviewCount: item.ratingCount ?? 0,
    imageUrl,
    productUrl,
    specs,
  };
}

export async function searchMyntra(params: SearchParams): Promise<Product[]> {
  if (process.env.USE_MOCK_DATA === 'true') {
    return getMockProducts('myntra', params.query, params);
  }

  try {
    const response = await axios.get<MyntraGatewayResponse>(GATEWAY_URL, {
      params: {
        rawQuery: params.query,
        resultsPerPage: 24,
        o: 0,
        plaEnabled: 'false',
      },
      headers: buildHeaders(),
      timeout: 12000,
    });

    const items: MyntraGatewayProduct[] =
      response.data?.searchData?.results?.products ??
      response.data?.products ??
      [];

    const products = items
      .map(normaliseProduct)
      .filter((p) => {
        if (params.minPrice && p.price > 0 && p.price < params.minPrice) return false;
        if (params.maxPrice && p.price > 0 && p.price > params.maxPrice) return false;
        return true;
      })
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 5);

    if (products.length > 0) return products;

    console.warn('[Myntra] Gateway returned 0 results — using mock fallback');
    return getMockProducts('myntra', params.query, params);
  } catch (err) {
    console.error('[Myntra] Gateway request failed:', err instanceof Error ? err.message : err);
    return getMockProducts('myntra', params.query, params);
  }
}

export async function getMyntraProduct(productId: string): Promise<Product | null> {
  if (process.env.USE_MOCK_DATA === 'true') {
    return getMockProduct('myntra', productId);
  }

  try {
    // Myntra product detail endpoint
    const response = await axios.get(`https://www.myntra.com/gateway/v2/product/${productId}`, {
      headers: buildHeaders(),
      timeout: 12000,
    });

    const d = response.data?.style ?? response.data;
    if (!d) return getMockProduct('myntra', productId);

    const price = d.price?.discounted ?? d.discountedPrice ?? 0;
    const specs: Record<string, string> = {};
    if (d.brand?.name) specs['Brand'] = d.brand.name;
    if (d.price?.marked) specs['MRP'] = `₹${d.price.marked}`;
    if (Array.isArray(d.articleAttributes)) {
      for (const attr of d.articleAttributes) {
        if (attr.name && attr.value) specs[attr.name] = attr.value;
      }
    }

    return {
      id: productId,
      platform: 'myntra',
      title: d.name ?? 'Unknown',
      price,
      currency: 'INR',
      rating: d.rating ?? 0,
      reviewCount: d.ratingCount ?? 0,
      imageUrl: d.media?.images?.[0]?.secureSrc ?? '',
      productUrl: `https://www.myntra.com/${productId}`,
      specs,
    };
  } catch (err) {
    console.error('[Myntra] Product detail failed:', err instanceof Error ? err.message : err);
    return getMockProduct('myntra', productId);
  }
}

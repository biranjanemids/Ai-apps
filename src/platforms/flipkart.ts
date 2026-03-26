import axios from 'axios';
import { Product, SearchParams } from '../types/index.js';

const RAPIDAPI_HOST = 'flipkart-api.p.rapidapi.com';

interface FlipkartProduct {
  pid: string;
  title: string;
  price: number;
  mrp?: number;
  rating?: number;
  ratingCount?: number;
  images?: string[];
  url?: string;
  brand?: string;
  highlights?: string[];
}

interface FlipkartSearchResponse {
  products?: FlipkartProduct[];
  results?: FlipkartProduct[];
}

export async function searchFlipkart(params: SearchParams): Promise<Product[]> {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) {
    console.error('[Flipkart] RAPIDAPI_KEY not set');
    return [];
  }

  try {
    const response = await axios.get<FlipkartSearchResponse>(
      `https://${RAPIDAPI_HOST}/productsSearch`,
      {
        params: {
          q: params.query,
          page: '1',
        },
        headers: {
          'X-RapidAPI-Key': key,
          'X-RapidAPI-Host': RAPIDAPI_HOST,
        },
        timeout: 10000,
      }
    );

    const items: FlipkartProduct[] =
      response.data?.products ?? response.data?.results ?? [];

    return items
      .filter((item) => {
        const price = item.price ?? 0;
        if (params.minPrice !== undefined && price < params.minPrice) return false;
        if (params.maxPrice !== undefined && price > params.maxPrice) return false;
        return true;
      })
      .slice(0, 5)
      .map((item) => ({
        id: item.pid,
        platform: 'flipkart',
        title: item.title,
        price: item.price ?? 0,
        currency: 'INR',
        rating: item.rating ?? 0,
        reviewCount: item.ratingCount ?? 0,
        imageUrl: item.images?.[0] ?? '',
        productUrl:
          item.url ??
          `https://www.flipkart.com/search?q=${encodeURIComponent(item.title)}`,
        specs: {
          ...(item.brand ? { Brand: item.brand } : {}),
          ...(item.mrp ? { MRP: `₹${item.mrp}` } : {}),
          ...(item.highlights?.length
            ? { Highlights: item.highlights.slice(0, 3).join(', ') }
            : {}),
        },
      }));
  } catch (err) {
    console.error('[Flipkart] Search failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

export async function getFlipkartProduct(productId: string): Promise<Product | null> {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return null;

  try {
    const response = await axios.get(`https://${RAPIDAPI_HOST}/productDetails`, {
      params: { pid: productId },
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': RAPIDAPI_HOST,
      },
      timeout: 10000,
    });

    const d = response.data;
    if (!d) return null;

    const specs: Record<string, string> = {};
    if (d.brand) specs['Brand'] = d.brand;
    if (d.mrp) specs['MRP'] = `₹${d.mrp}`;
    if (Array.isArray(d.highlights)) {
      specs['Highlights'] = d.highlights.slice(0, 3).join(', ');
    }
    if (Array.isArray(d.specifications)) {
      for (const section of d.specifications) {
        if (Array.isArray(section.attributes)) {
          for (const attr of section.attributes) {
            if (attr.key && attr.value) specs[attr.key] = attr.value;
          }
        }
      }
    }

    return {
      id: productId,
      platform: 'flipkart',
      title: d.title ?? 'Unknown',
      price: d.price ?? 0,
      currency: 'INR',
      rating: d.rating ?? 0,
      reviewCount: d.ratingCount ?? 0,
      imageUrl: d.images?.[0] ?? '',
      productUrl: d.url ?? `https://www.flipkart.com/search?q=${productId}`,
      specs,
    };
  } catch (err) {
    console.error('[Flipkart] Product fetch failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

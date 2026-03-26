import axios from 'axios';
import { Product, SearchParams } from '../types/index.js';

const RAPIDAPI_HOST = 'real-time-amazon-data.p.rapidapi.com';

interface AmazonSearchItem {
  asin: string;
  product_title: string;
  product_price: string;
  product_star_rating: string;
  product_num_ratings: number;
  product_photo: string;
  product_url: string;
  product_byline?: string;
}

export async function searchAmazon(params: SearchParams): Promise<Product[]> {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) {
    console.error('[Amazon] RAPIDAPI_KEY not set');
    return [];
  }

  try {
    const queryParams: Record<string, string> = {
      query: params.query,
      page: '1',
      country: 'IN',
      sort_by: 'RELEVANCE',
      product_condition: 'ALL',
    };
    if (params.minPrice !== undefined) queryParams.min_price = String(params.minPrice);
    if (params.maxPrice !== undefined) queryParams.max_price = String(params.maxPrice);

    const response = await axios.get(`https://${RAPIDAPI_HOST}/search`, {
      params: queryParams,
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': RAPIDAPI_HOST,
      },
      timeout: 10000,
    });

    const items: AmazonSearchItem[] = response.data?.data?.products ?? [];
    return items.slice(0, 5).map((item) => ({
      id: item.asin,
      platform: 'amazon',
      title: item.product_title,
      price: parseFloat(item.product_price?.replace(/[^0-9.]/g, '') ?? '0') || 0,
      currency: 'INR',
      rating: parseFloat(item.product_star_rating ?? '0') || 0,
      reviewCount: item.product_num_ratings ?? 0,
      imageUrl: item.product_photo ?? '',
      productUrl: item.product_url ?? `https://www.amazon.in/dp/${item.asin}`,
      specs: item.product_byline ? ({ Brand: item.product_byline } as Record<string, string>) : ({} as Record<string, string>),
    }));
  } catch (err) {
    console.error('[Amazon] Search failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

export async function getAmazonProduct(productId: string): Promise<Product | null> {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return null;

  try {
    const response = await axios.get(`https://${RAPIDAPI_HOST}/product-details`, {
      params: { asin: productId, country: 'IN' },
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': RAPIDAPI_HOST,
      },
      timeout: 10000,
    });

    const d = response.data?.data;
    if (!d) return null;

    const specs: Record<string, string> = {};
    if (Array.isArray(d.product_information)) {
      for (const info of d.product_information) {
        if (info.name && info.value) specs[info.name] = info.value;
      }
    }

    return {
      id: productId,
      platform: 'amazon',
      title: d.product_title ?? 'Unknown',
      price: parseFloat(d.product_price?.replace(/[^0-9.]/g, '') ?? '0') || 0,
      currency: 'INR',
      rating: parseFloat(d.product_star_rating ?? '0') || 0,
      reviewCount: d.product_num_ratings ?? 0,
      imageUrl: d.product_main_image_url ?? '',
      productUrl: `https://www.amazon.in/dp/${productId}`,
      specs,
    };
  } catch (err) {
    console.error('[Amazon] Product fetch failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

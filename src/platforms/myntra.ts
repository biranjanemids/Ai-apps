import axios from 'axios';
import { Product, SearchParams } from '../types/index.js';

const RAPIDAPI_HOST = 'myntra-fashion-products.p.rapidapi.com';

interface MyntraProduct {
  productId: number | string;
  productName?: string;
  name?: string;
  brand?: string;
  price?: {
    discounted?: number;
    marked?: number;
  };
  discountedPrice?: number;
  mrp?: number;
  rating?: number;
  ratingCount?: number;
  images?: Array<{ src?: string; secureSrc?: string }>;
  landingPageUrl?: string;
  category?: string;
  gender?: string;
}

interface MyntraSearchResponse {
  products?: MyntraProduct[];
  results?: MyntraProduct[];
  data?: { products?: MyntraProduct[] };
}

export async function searchMyntra(params: SearchParams): Promise<Product[]> {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) {
    console.error('[Myntra] RAPIDAPI_KEY not set');
    return [];
  }

  try {
    const response = await axios.get<MyntraSearchResponse>(
      `https://${RAPIDAPI_HOST}/search`,
      {
        params: {
          query: params.query,
          rows: '10',
          start: '0',
          o: '0',
          plaEnabled: 'false',
        },
        headers: {
          'X-RapidAPI-Key': key,
          'X-RapidAPI-Host': RAPIDAPI_HOST,
        },
        timeout: 10000,
      }
    );

    const items: MyntraProduct[] =
      response.data?.products ??
      response.data?.results ??
      response.data?.data?.products ??
      [];

    return items
      .filter((item) => {
        const price = item.price?.discounted ?? item.discountedPrice ?? item.mrp ?? 0;
        if (params.minPrice !== undefined && price < params.minPrice) return false;
        if (params.maxPrice !== undefined && price > params.maxPrice) return false;
        return true;
      })
      .slice(0, 5)
      .map((item) => {
        const price = item.price?.discounted ?? item.discountedPrice ?? item.mrp ?? 0;
        const mrp = item.price?.marked ?? item.mrp;
        const productId = String(item.productId);
        const title = item.productName ?? item.name ?? 'Unknown';
        const imageUrl =
          item.images?.[0]?.secureSrc ?? item.images?.[0]?.src ?? '';
        const productUrl =
          item.landingPageUrl ??
          `https://www.myntra.com/${productId}`;

        const specs: Record<string, string> = {};
        if (item.brand) specs['Brand'] = item.brand;
        if (mrp) specs['MRP'] = `₹${mrp}`;
        if (item.category) specs['Category'] = item.category;
        if (item.gender) specs['Gender'] = item.gender;

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
      });
  } catch (err) {
    console.error('[Myntra] Search failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

export async function getMyntraProduct(productId: string): Promise<Product | null> {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return null;

  try {
    const response = await axios.get(`https://${RAPIDAPI_HOST}/products/details`, {
      params: { id: productId },
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': RAPIDAPI_HOST,
      },
      timeout: 10000,
    });

    const d = response.data?.style ?? response.data;
    if (!d) return null;

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
    console.error('[Myntra] Product fetch failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

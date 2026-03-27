import axios from 'axios';
import * as cheerio from 'cheerio';
import { Product, SearchParams } from '../types/index.js';
import { getMockProducts, getMockProduct, randomUserAgent } from './mock.js';

const BASE = 'https://www.amazon.in';

function buildHeaders() {
  return {
    'User-Agent': randomUserAgent(),
    'Accept-Language': 'en-IN,en;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  };
}

export async function searchAmazon(params: SearchParams): Promise<Product[]> {
  if (process.env.USE_MOCK_DATA === 'true') {
    return getMockProducts('amazon', params.query, params);
  }

  try {
    let url = `${BASE}/s?k=${encodeURIComponent(params.query)}&i=aps`;
    if (params.minPrice !== undefined || params.maxPrice !== undefined) {
      const lo = (params.minPrice ?? 0) * 100;
      const hi = params.maxPrice ? params.maxPrice * 100 : '';
      url += `&rh=p_36%3A${lo}-${hi}`;
    }

    const { data } = await axios.get<string>(url, {
      headers: buildHeaders(),
      timeout: 12000,
    });

    const $ = cheerio.load(data);
    const products: Product[] = [];

    $('[data-asin]').each((_, el) => {
      if (products.length >= 5) return false;

      const asin = $(el).attr('data-asin');
      if (!asin || asin.trim() === '') return;

      const title = $('h2 a span', el).first().text().trim();
      if (!title) return;

      const priceWhole = $('.a-price-whole', el).first().text().replace(/[^0-9]/g, '');
      const priceFraction = $('.a-price-fraction', el).first().text().replace(/[^0-9]/g, '');
      const price = priceWhole
        ? parseFloat(`${priceWhole}.${priceFraction || '00'}`)
        : 0;

      const ratingText = $('.a-icon-alt', el).first().text(); // "4.2 out of 5 stars"
      const rating = parseFloat(ratingText) || 0;

      const reviewText = $('[aria-label$="stars"]', el).parent().next().text().replace(/[^0-9]/g, '');
      const reviewCount = parseInt(reviewText) || 0;

      const imageUrl = $('img.s-image', el).attr('src') ?? '';
      const relativeUrl = $('h2 a', el).attr('href') ?? '';
      const productUrl = relativeUrl.startsWith('http') ? relativeUrl : `${BASE}${relativeUrl}`;

      if (params.minPrice && price > 0 && price < params.minPrice) return;
      if (params.maxPrice && price > 0 && price > params.maxPrice) return;

      products.push({
        id: asin,
        platform: 'amazon',
        title,
        price,
        currency: 'INR',
        rating,
        reviewCount,
        imageUrl,
        productUrl,
        specs: {} as Record<string, string>,
      });
    });

    if (products.length > 0) return products;

    console.warn('[Amazon] Scraping returned 0 results — using mock fallback');
    return getMockProducts('amazon', params.query, params);
  } catch (err) {
    console.error('[Amazon] Scraping failed:', err instanceof Error ? err.message : err);
    return getMockProducts('amazon', params.query, params);
  }
}

export async function getAmazonProduct(productId: string): Promise<Product | null> {
  if (process.env.USE_MOCK_DATA === 'true') {
    return getMockProduct('amazon', productId);
  }

  try {
    const { data } = await axios.get<string>(`${BASE}/dp/${productId}`, {
      headers: buildHeaders(),
      timeout: 12000,
    });

    const $ = cheerio.load(data);

    const title = $('#productTitle').text().trim();
    if (!title) {
      return getMockProduct('amazon', productId);
    }

    const priceText = $('.a-price .a-offscreen').first().text().replace(/[^0-9.]/g, '');
    const price = parseFloat(priceText) || 0;

    const ratingText = $('#acrPopover').attr('title') ?? '';
    const rating = parseFloat(ratingText) || 0;

    const reviewText = $('#acrCustomerReviewText').text().replace(/[^0-9]/g, '');
    const reviewCount = parseInt(reviewText) || 0;

    const imageUrl = $('#landingImage').attr('src') ?? '';

    const specs: Record<string, string> = {};
    $('#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr').each((_, row) => {
      const key = $('th', row).text().trim();
      const val = $('td', row).text().trim();
      if (key && val) specs[key] = val;
    });

    // Also grab bullet-style specs
    $('#feature-bullets li span').each((_, el) => {
      const text = $(el).text().trim();
      if (text && !specs['Highlights']) specs['Highlights'] = text;
    });

    return {
      id: productId,
      platform: 'amazon',
      title,
      price,
      currency: 'INR',
      rating,
      reviewCount,
      imageUrl,
      productUrl: `${BASE}/dp/${productId}`,
      specs,
    };
  } catch (err) {
    console.error('[Amazon] Product detail scraping failed:', err instanceof Error ? err.message : err);
    return getMockProduct('amazon', productId);
  }
}

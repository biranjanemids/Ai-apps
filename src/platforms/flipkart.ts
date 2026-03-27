import axios from 'axios';
import * as cheerio from 'cheerio';
import { Product, SearchParams } from '../types/index.js';
import { getMockProducts, getMockProduct, randomUserAgent } from './mock.js';

const BASE = 'https://www.flipkart.com';

function buildHeaders() {
  return {
    'User-Agent': randomUserAgent(),
    'Accept-Language': 'en-IN,en;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  };
}

function extractProductId(href: string): string {
  // Flipkart URLs: /product-name/p/ITEMID or pid=ITEMID in query string
  const pidMatch = href.match(/[?&]pid=([^&]+)/);
  if (pidMatch) return pidMatch[1];
  const pathMatch = href.match(/\/p\/([A-Z0-9]+)/);
  if (pathMatch) return pathMatch[1];
  // fallback: hash the URL
  return Buffer.from(href).toString('base64').slice(0, 16);
}

function parsePrice(text: string): number {
  return parseFloat(text.replace(/[^0-9.]/g, '')) || 0;
}

export async function searchFlipkart(params: SearchParams): Promise<Product[]> {
  if (process.env.USE_MOCK_DATA === 'true') {
    return getMockProducts('flipkart', params.query, params);
  }

  try {
    const url = `${BASE}/search?q=${encodeURIComponent(params.query)}&as-show=on&as=off`;

    const { data } = await axios.get<string>(url, {
      headers: buildHeaders(),
      timeout: 12000,
    });

    const $ = cheerio.load(data);
    const products: Product[] = [];

    // Flipkart product cards — multiple class patterns depending on category
    const cardSelectors = [
      '._1AtVbE',   // grid view
      '._13oc-S',   // list view
      '.tUxRFH',    // newer layout
      '._2kHMtA',   // another variant
    ];

    const cards = $(cardSelectors.join(', '));

    cards.each((_, el) => {
      if (products.length >= 5) return false;

      // Title — try multiple class patterns
      const title =
        $('._4rR01T', el).text().trim() ||
        $('.IRpwTa', el).text().trim() ||
        $('.s1Q9rs', el).text().trim() ||
        $('a[title]', el).attr('title')?.trim() ||
        '';

      if (!title) return;

      // Price
      const priceText = $('.Nx9bqj', el).first().text() ||
        $('._30jeq3', el).first().text() ||
        $('._1_WHN1', el).first().text();
      const price = parsePrice(priceText);

      if (params.minPrice && price > 0 && price < params.minPrice) return;
      if (params.maxPrice && price > 0 && price > params.maxPrice) return;

      // Rating
      const ratingText = $('.XQDdHH', el).first().text() ||
        $('._3LWZlK', el).first().text() ||
        $('.gUuXy-', el).first().text();
      const rating = parseFloat(ratingText) || 0;

      // Image
      const imageUrl =
        $('img._396cs4', el).attr('src') ||
        $('img._2r_T1I', el).attr('src') ||
        $('img', el).first().attr('src') ||
        '';

      // Link
      const href =
        $('a._1fQZEK', el).attr('href') ||
        $('a.IRpwTa', el).attr('href') ||
        $('a[href*="/p/"]', el).first().attr('href') ||
        '';

      const productUrl = href.startsWith('http') ? href : `${BASE}${href}`;
      const id = href ? extractProductId(href) : `fk-${Date.now()}-${products.length}`;

      products.push({
        id,
        platform: 'flipkart',
        title,
        price,
        currency: 'INR',
        rating,
        reviewCount: 0,
        imageUrl,
        productUrl,
        specs: {} as Record<string, string>,
      });
    });

    if (products.length > 0) return products;

    console.warn('[Flipkart] Scraping returned 0 results — using mock fallback');
    return getMockProducts('flipkart', params.query, params);
  } catch (err) {
    console.error('[Flipkart] Scraping failed:', err instanceof Error ? err.message : err);
    return getMockProducts('flipkart', params.query, params);
  }
}

export async function getFlipkartProduct(productId: string): Promise<Product | null> {
  const mock = getMockProduct('flipkart', productId);
  if (process.env.USE_MOCK_DATA === 'true' || mock) return mock;

  try {
    // Flipkart product detail pages require pid param
    const url = `${BASE}/product/p/p?pid=${productId}`;
    const { data } = await axios.get<string>(url, {
      headers: buildHeaders(),
      timeout: 12000,
    });

    const $ = cheerio.load(data);

    const title = $('span.B_NuCI').text().trim() || $('._35KyD6').text().trim();
    if (!title) return getMockProduct('flipkart', productId);

    const priceText = $('._30jeq3._16Jk6d').text() || $('.Nx9bqj').first().text();
    const price = parsePrice(priceText);

    const ratingText = $('._3LWZlK').first().text();
    const rating = parseFloat(ratingText) || 0;

    const imageUrl = $('img._396cs4').first().attr('src') ?? '';

    const specs: Record<string, string> = {};
    $('._21lJbe').each((_, row) => {
      const key = $('._1hKmbr', row).text().trim();
      const val = $('.URwL2w', row).text().trim();
      if (key && val) specs[key] = val;
    });

    return {
      id: productId,
      platform: 'flipkart',
      title,
      price,
      currency: 'INR',
      rating,
      reviewCount: 0,
      imageUrl,
      productUrl: `${BASE}/product/p/p?pid=${productId}`,
      specs,
    };
  } catch (err) {
    console.error('[Flipkart] Product detail scraping failed:', err instanceof Error ? err.message : err);
    return getMockProduct('flipkart', productId);
  }
}

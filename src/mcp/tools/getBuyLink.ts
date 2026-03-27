import { getAmazonProduct } from '../../platforms/amazon.js';
import { getFlipkartProduct } from '../../platforms/flipkart.js';
import { getMyntraProduct } from '../../platforms/myntra.js';
import { getMockProduct } from '../../platforms/mock.js';

export interface BuyLinkResult {
  platform: string;
  productId: string;
  title: string;
  price: number;
  imageUrl: string;
  productUrl: string;      // product detail page
  checkoutUrl: string;     // direct add-to-cart / buy-now URL
}

function buildAmazonCheckoutUrl(asin: string): string {
  // Add to cart and redirect straight to checkout
  return `https://www.amazon.in/gp/aws/cart/add.html?ASIN.1=${asin}&Quantity.1=1`;
}

function buildFlipkartCheckoutUrl(productUrl: string, pid: string): string {
  // Flipkart buy-now deep link — appending affid for tracking + direct buy
  const base = productUrl.split('?')[0];
  return `${base}?param=buyNow&pid=${pid}`;
}

function buildMyntraCheckoutUrl(productUrl: string, productId: string): string {
  // Myntra buy URLs already contain /buy — normalise
  const clean = productUrl.replace(/\?.*$/, '');
  if (clean.endsWith('/buy')) return clean;
  return `https://www.myntra.com/${productId}/buy`;
}

export async function getBuyLink(
  productId: string,
  platform: string
): Promise<BuyLinkResult> {
  const fallback = getMockProduct(platform, productId);

  try {
    let title = fallback?.title ?? 'Product';
    let price = fallback?.price ?? 0;
    let imageUrl = fallback?.imageUrl ?? '';
    let productUrl = '';
    let checkoutUrl = '';

    switch (platform) {
      case 'amazon': {
        const product = await getAmazonProduct(productId);
        const p = product ?? fallback;
        title = p?.title ?? title;
        price = p?.price ?? price;
        imageUrl = p?.imageUrl ?? imageUrl;
        productUrl = p?.productUrl ?? `https://www.amazon.in/dp/${productId}`;
        checkoutUrl = buildAmazonCheckoutUrl(productId);
        break;
      }
      case 'flipkart': {
        const product = await getFlipkartProduct(productId);
        const p = product ?? fallback;
        title = p?.title ?? title;
        price = p?.price ?? price;
        imageUrl = p?.imageUrl ?? imageUrl;
        productUrl = p?.productUrl ?? `https://www.flipkart.com/search?q=${productId}`;
        checkoutUrl = buildFlipkartCheckoutUrl(productUrl, productId);
        break;
      }
      case 'myntra': {
        const product = await getMyntraProduct(productId);
        const p = product ?? fallback;
        title = p?.title ?? title;
        price = p?.price ?? price;
        imageUrl = p?.imageUrl ?? imageUrl;
        productUrl = p?.productUrl ?? `https://www.myntra.com/${productId}`;
        checkoutUrl = buildMyntraCheckoutUrl(productUrl, productId);
        break;
      }
      default:
        productUrl = '';
        checkoutUrl = '';
    }

    return { platform, productId, title, price, imageUrl, productUrl, checkoutUrl };
  } catch {
    const p = fallback;
    const productUrl = p?.productUrl ?? '';
    return {
      platform,
      productId,
      title: p?.title ?? 'Product',
      price: p?.price ?? 0,
      imageUrl: p?.imageUrl ?? '',
      productUrl,
      checkoutUrl: buildCheckoutFallback(platform, productId, productUrl),
    };
  }
}

function buildCheckoutFallback(platform: string, productId: string, productUrl: string): string {
  switch (platform) {
    case 'amazon':   return buildAmazonCheckoutUrl(productId);
    case 'flipkart': return buildFlipkartCheckoutUrl(productUrl, productId);
    case 'myntra':   return buildMyntraCheckoutUrl(productUrl, productId);
    default:         return productUrl;
  }
}

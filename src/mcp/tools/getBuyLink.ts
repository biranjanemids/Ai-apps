import { getAmazonProduct } from '../../platforms/amazon.js';
import { getFlipkartProduct } from '../../platforms/flipkart.js';
import { getMyntraProduct } from '../../platforms/myntra.js';
import { getMeeshoProduct } from '../../platforms/meesho.js';
import { getNykaaProduct } from '../../platforms/nykaa.js';
import { getAjioProduct } from '../../platforms/ajio.js';
import { getZeptoProduct } from '../../platforms/zepto.js';
import { getInstamartProduct } from '../../platforms/instamart.js';
import { getMockProduct } from '../../platforms/mock.js';

export interface BuyLinkResult {
  platform: string;
  productId: string;
  title: string;
  price: number;
  imageUrl: string;
  productUrl: string;
  checkoutUrl: string;
}

function buildAmazonCheckoutUrl(asin: string): string {
  return `https://www.amazon.in/gp/aws/cart/add.html?ASIN.1=${asin}&Quantity.1=1`;
}

function buildFlipkartCheckoutUrl(productUrl: string, pid: string): string {
  const base = productUrl.split('?')[0];
  return `${base}?param=buyNow&pid=${pid}`;
}

function buildMyntraCheckoutUrl(productUrl: string, productId: string): string {
  const clean = productUrl.replace(/\?.*$/, '');
  if (clean.endsWith('/buy')) return clean;
  return `https://www.myntra.com/${productId}/buy`;
}

// Meesho: direct product page (no cart API; user completes on site)
function buildMeeshoCheckoutUrl(productUrl: string): string {
  return productUrl;
}

// Nykaa: add to cart redirect
function buildNykaaCheckoutUrl(productId: string): string {
  return `https://www.nykaa.com/checkout/cart/add?productId=${productId}&skuId=${productId}`;
}

// Ajio: add to bag redirect
function buildAjioCheckoutUrl(productUrl: string): string {
  return productUrl;
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
        const p = (await getAmazonProduct(productId)) ?? fallback;
        title = p?.title ?? title;
        price = p?.price ?? price;
        imageUrl = p?.imageUrl ?? imageUrl;
        productUrl = p?.productUrl ?? `https://www.amazon.in/dp/${productId}`;
        checkoutUrl = buildAmazonCheckoutUrl(productId);
        break;
      }
      case 'flipkart': {
        const p = (await getFlipkartProduct(productId)) ?? fallback;
        title = p?.title ?? title;
        price = p?.price ?? price;
        imageUrl = p?.imageUrl ?? imageUrl;
        productUrl = p?.productUrl ?? `https://www.flipkart.com/search?q=${productId}`;
        checkoutUrl = buildFlipkartCheckoutUrl(productUrl, productId);
        break;
      }
      case 'myntra': {
        const p = (await getMyntraProduct(productId)) ?? fallback;
        title = p?.title ?? title;
        price = p?.price ?? price;
        imageUrl = p?.imageUrl ?? imageUrl;
        productUrl = p?.productUrl ?? `https://www.myntra.com/${productId}`;
        checkoutUrl = buildMyntraCheckoutUrl(productUrl, productId);
        break;
      }
      case 'meesho': {
        const p = (await getMeeshoProduct(productId)) ?? fallback;
        title = p?.title ?? title;
        price = p?.price ?? price;
        imageUrl = p?.imageUrl ?? imageUrl;
        productUrl = p?.productUrl ?? `https://www.meesho.com/product/p/${productId}`;
        checkoutUrl = buildMeeshoCheckoutUrl(productUrl);
        break;
      }
      case 'nykaa': {
        const p = (await getNykaaProduct(productId)) ?? fallback;
        title = p?.title ?? title;
        price = p?.price ?? price;
        imageUrl = p?.imageUrl ?? imageUrl;
        productUrl = p?.productUrl ?? `https://www.nykaa.com/product/p/${productId}`;
        checkoutUrl = buildNykaaCheckoutUrl(productId);
        break;
      }
      case 'ajio': {
        const p = (await getAjioProduct(productId)) ?? fallback;
        title = p?.title ?? title;
        price = p?.price ?? price;
        imageUrl = p?.imageUrl ?? imageUrl;
        productUrl = p?.productUrl ?? `https://www.ajio.com/p/${productId}`;
        checkoutUrl = buildAjioCheckoutUrl(productUrl);
        break;
      }
      // Quick-commerce: purchase completes on the product page / in the app
      case 'zepto': {
        const p = (await getZeptoProduct(productId)) ?? fallback;
        title = p?.title ?? title;
        price = p?.price ?? price;
        imageUrl = p?.imageUrl ?? imageUrl;
        productUrl = p?.productUrl ?? `https://www.zeptonow.com/pvid/${productId}`;
        checkoutUrl = productUrl;
        break;
      }
      case 'instamart': {
        const p = (await getInstamartProduct(productId)) ?? fallback;
        title = p?.title ?? title;
        price = p?.price ?? price;
        imageUrl = p?.imageUrl ?? imageUrl;
        productUrl = p?.productUrl ?? `https://www.swiggy.com/instamart/item/${productId}`;
        checkoutUrl = productUrl;
        break;
      }
      default:
        productUrl = fallback?.productUrl ?? '';
        checkoutUrl = productUrl;
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
    case 'nykaa':    return buildNykaaCheckoutUrl(productId);
    default:         return productUrl;
  }
}

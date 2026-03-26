import { getAmazonProduct } from '../../platforms/amazon.js';
import { getFlipkartProduct } from '../../platforms/flipkart.js';
import { getMyntraProduct } from '../../platforms/myntra.js';

export async function getBuyLink(
  productId: string,
  platform: string
): Promise<{ url: string; platform: string; productId: string }> {
  let url = '';

  try {
    switch (platform) {
      case 'amazon': {
        const product = await getAmazonProduct(productId);
        url = product?.productUrl ?? `https://www.amazon.in/dp/${productId}`;
        break;
      }
      case 'flipkart': {
        const product = await getFlipkartProduct(productId);
        url = product?.productUrl ?? `https://www.flipkart.com/search?q=${productId}`;
        break;
      }
      case 'myntra': {
        const product = await getMyntraProduct(productId);
        url = product?.productUrl ?? `https://www.myntra.com/${productId}`;
        break;
      }
      default:
        url = '';
    }
  } catch {
    url = getPlatformFallbackUrl(productId, platform);
  }

  return { url, platform, productId };
}

function getPlatformFallbackUrl(productId: string, platform: string): string {
  switch (platform) {
    case 'amazon':
      return `https://www.amazon.in/dp/${productId}`;
    case 'flipkart':
      return `https://www.flipkart.com/search?q=${productId}`;
    case 'myntra':
      return `https://www.myntra.com/${productId}`;
    default:
      return '';
  }
}

import { getAmazonProduct } from '../../platforms/amazon.js';
import { getFlipkartProduct } from '../../platforms/flipkart.js';
import { getMyntraProduct } from '../../platforms/myntra.js';
import { getMeeshoProduct } from '../../platforms/meesho.js';
import { getNykaaProduct } from '../../platforms/nykaa.js';
import { getAjioProduct } from '../../platforms/ajio.js';
import { getZeptoProduct } from '../../platforms/zepto.js';
import { getInstamartProduct } from '../../platforms/instamart.js';
import { getLiveProduct } from '../../platforms/liveRegistry.js';
import { Product } from '../../types/index.js';

export async function getProductDetails(
  productId: string,
  platform: string
): Promise<Product | null> {
  // Products from the live aggregated source carry synthetic IDs — resolve
  // them from the registry instead of hitting a platform adapter
  const live = getLiveProduct(productId);
  if (live) return live;

  switch (platform) {
    case 'amazon':    return getAmazonProduct(productId);
    case 'flipkart':  return getFlipkartProduct(productId);
    case 'myntra':    return getMyntraProduct(productId);
    case 'meesho':    return getMeeshoProduct(productId);
    case 'nykaa':     return getNykaaProduct(productId);
    case 'ajio':      return getAjioProduct(productId);
    case 'zepto':     return getZeptoProduct(productId);
    case 'instamart': return getInstamartProduct(productId);
    default:          return null;
  }
}

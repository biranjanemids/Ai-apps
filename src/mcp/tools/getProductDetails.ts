import { getAmazonProduct } from '../../platforms/amazon.js';
import { getFlipkartProduct } from '../../platforms/flipkart.js';
import { getMyntraProduct } from '../../platforms/myntra.js';
import { getMeeshoProduct } from '../../platforms/meesho.js';
import { getNykaaProduct } from '../../platforms/nykaa.js';
import { getAjioProduct } from '../../platforms/ajio.js';
import { Product } from '../../types/index.js';

export async function getProductDetails(
  productId: string,
  platform: string
): Promise<Product | null> {
  switch (platform) {
    case 'amazon':   return getAmazonProduct(productId);
    case 'flipkart': return getFlipkartProduct(productId);
    case 'myntra':   return getMyntraProduct(productId);
    case 'meesho':   return getMeeshoProduct(productId);
    case 'nykaa':    return getNykaaProduct(productId);
    case 'ajio':     return getAjioProduct(productId);
    default:         return null;
  }
}

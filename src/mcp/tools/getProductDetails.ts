import { getAmazonProduct } from '../../platforms/amazon.js';
import { getFlipkartProduct } from '../../platforms/flipkart.js';
import { getMyntraProduct } from '../../platforms/myntra.js';
import { Product } from '../../types/index.js';

export async function getProductDetails(
  productId: string,
  platform: string
): Promise<Product | null> {
  switch (platform) {
    case 'amazon':
      return getAmazonProduct(productId);
    case 'flipkart':
      return getFlipkartProduct(productId);
    case 'myntra':
      return getMyntraProduct(productId);
    default:
      return null;
  }
}

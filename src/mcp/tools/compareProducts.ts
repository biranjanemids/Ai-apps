import { getAmazonProduct } from '../../platforms/amazon.js';
import { getFlipkartProduct } from '../../platforms/flipkart.js';
import { getMyntraProduct } from '../../platforms/myntra.js';
import { getMeeshoProduct } from '../../platforms/meesho.js';
import { getNykaaProduct } from '../../platforms/nykaa.js';
import { getAjioProduct } from '../../platforms/ajio.js';
import { Product, ComparisonRow } from '../../types/index.js';

export async function compareProducts(
  productRefs: Array<{ productId: string; platform: string }>
): Promise<{
  products: Product[];
  comparisonTable: ComparisonRow[];
}> {
  const fetches = productRefs.map(({ productId, platform }) => {
    switch (platform) {
      case 'amazon':
        return getAmazonProduct(productId);
      case 'flipkart':
        return getFlipkartProduct(productId);
      case 'myntra':
        return getMyntraProduct(productId);
      case 'meesho':
        return getMeeshoProduct(productId);
      case 'nykaa':
        return getNykaaProduct(productId);
      case 'ajio':
        return getAjioProduct(productId);
      default:
        return Promise.resolve(null);
    }
  });

  const results = await Promise.allSettled(fetches);
  const products: Product[] = results
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((p): p is Product => p !== null);

  if (products.length === 0) {
    return { products: [], comparisonTable: [] };
  }

  const allSpecKeys = new Set<string>();
  for (const p of products) {
    Object.keys(p.specs).forEach((k) => allSpecKeys.add(k));
  }

  const comparisonTable: ComparisonRow[] = [
    {
      attribute: 'Platform',
      values: Object.fromEntries(products.map((p) => [p.id, p.platform.toUpperCase()])),
    },
    {
      attribute: 'Price (₹)',
      values: Object.fromEntries(
        products.map((p) => [p.id, p.price > 0 ? `₹${p.price.toLocaleString('en-IN')}` : 'N/A'])
      ),
    },
    {
      attribute: 'Rating',
      values: Object.fromEntries(
        products.map((p) => [p.id, p.rating > 0 ? `${p.rating}/5 (${p.reviewCount} reviews)` : 'N/A'])
      ),
    },
    ...[...allSpecKeys].slice(0, 5).map((key) => ({
      attribute: key,
      values: Object.fromEntries(products.map((p) => [p.id, p.specs[key] ?? 'N/A'])),
    })),
  ];

  return { products, comparisonTable };
}

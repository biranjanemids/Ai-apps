import { Product, ComparisonRow } from '../types/index.js';

const PLATFORM_EMOJI: Record<string, string> = {
  amazon: '🛒',
  flipkart: '🛍',
  myntra: '👗',
};

export function formatSearchResults(
  results: Array<{ platform: string; products: Product[]; error?: string }>,
  startIndex = 1
): { text: string; allProducts: Product[] } {
  const allProducts: Product[] = [];
  const lines: string[] = [];
  let index = startIndex;

  for (const r of results) {
    const emoji = PLATFORM_EMOJI[r.platform] ?? '🏪';
    const platformName = r.platform.charAt(0).toUpperCase() + r.platform.slice(1);

    if (r.error) {
      lines.push(`${emoji} *${platformName}*: Unavailable right now`);
      continue;
    }
    if (r.products.length === 0) {
      lines.push(`${emoji} *${platformName}*: No results found`);
      continue;
    }

    lines.push(`${emoji} *${platformName}*`);
    for (const product of r.products) {
      const title = truncate(product.title, 55);
      const price = product.price > 0 ? `₹${product.price.toLocaleString('en-IN')}` : 'Price N/A';
      const rating = product.rating > 0 ? ` ⭐${product.rating}` : '';
      lines.push(`  ${index}. ${title}\n     ${price}${rating}`);
      allProducts.push(product);
      index++;
    }
    lines.push('');
  }

  return { text: lines.join('\n').trim(), allProducts };
}

export function formatComparison(
  products: Product[],
  comparisonTable: ComparisonRow[]
): string {
  if (products.length === 0) return 'Could not fetch product details for comparison.';

  const lines: string[] = ['📊 *Product Comparison*\n'];

  for (const row of comparisonTable) {
    lines.push(`*${row.attribute}*`);
    for (const product of products) {
      const value = row.values[product.id] ?? 'N/A';
      const emoji = PLATFORM_EMOJI[product.platform] ?? '🏪';
      const title = truncate(product.title, 30);
      lines.push(`  ${emoji} ${title}: ${value}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

export function formatProductDetail(product: Product): string {
  const emoji = PLATFORM_EMOJI[product.platform] ?? '🏪';
  const platform = product.platform.charAt(0).toUpperCase() + product.platform.slice(1);
  const price = product.price > 0 ? `₹${product.price.toLocaleString('en-IN')}` : 'N/A';
  const rating = product.rating > 0
    ? `${product.rating}/5 (${product.reviewCount} reviews)`
    : 'No ratings';

  const lines = [
    `${emoji} *${platform}*`,
    `*${product.title}*`,
    `💰 Price: ${price}`,
    `⭐ Rating: ${rating}`,
  ];

  const specEntries = Object.entries(product.specs).slice(0, 5);
  if (specEntries.length > 0) {
    lines.push('');
    lines.push('*Specs:*');
    for (const [key, val] of specEntries) {
      lines.push(`  • ${key}: ${val}`);
    }
  }

  return lines.join('\n');
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

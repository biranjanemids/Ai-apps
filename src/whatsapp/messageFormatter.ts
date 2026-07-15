import { Product, ComparisonRow } from '../types/index.js';
import { discountPercent } from '../mcp/tools/searchProducts.js';

const PLATFORM_EMOJI: Record<string, string> = {
  amazon: '🛒',
  flipkart: '🛍',
  myntra: '👗',
  meesho: '🏷️',
  nykaa: '💄',
  ajio: '👔',
  zepto: '⚡',
  instamart: '🥦',
};

export function formatSearchResults(
  results: Array<{ platform: string; products: Product[]; error?: string }>,
  startIndex = 1,
  cheapestPlatform?: string,
  bestValuePlatform?: string
): { text: string; allProducts: Product[] } {
  const allProducts: Product[] = [];
  const lines: string[] = [];
  let index = startIndex;

  // Cross-platform insight header
  if (cheapestPlatform || bestValuePlatform) {
    const cheap = cheapestPlatform
      ? cheapestPlatform.charAt(0).toUpperCase() + cheapestPlatform.slice(1)
      : null;
    const val = bestValuePlatform
      ? bestValuePlatform.charAt(0).toUpperCase() + bestValuePlatform.slice(1)
      : null;
    const insight =
      cheapestPlatform === bestValuePlatform && cheap
        ? `💡 Best price & value: *${cheap}*`
        : [cheap ? `💡 Cheapest: *${cheap}*` : '', val ? `⭐ Best value: *${val}*` : '']
            .filter(Boolean)
            .join(' · ');
    if (insight) lines.push(insight, '');
  }

  for (const r of results) {
    const emoji = PLATFORM_EMOJI[r.platform] ?? '🏪';
    const platformName = r.platform.charAt(0).toUpperCase() + r.platform.slice(1);
    const badges = [
      r.platform === cheapestPlatform ? '🏷️ Cheapest' : '',
      r.platform === bestValuePlatform ? '⭐ Best Value' : '',
    ]
      .filter(Boolean)
      .join(' · ');

    if (r.error) {
      lines.push(`${emoji} *${platformName}*: Unavailable right now`);
      continue;
    }
    if (r.products.length === 0) {
      lines.push(`${emoji} *${platformName}*: No results found`);
      continue;
    }

    lines.push(`${emoji} *${platformName}*${badges ? `  ${badges}` : ''}`);
    for (const product of r.products) {
      const title = truncate(product.title, 50);
      const price = product.price > 0 ? `₹${product.price.toLocaleString('en-IN')}` : 'Price N/A';
      const rating = product.rating > 0 ? ` ⭐${product.rating}` : '';
      const disc = discountPercent(product);
      const discTag = disc >= 5 ? ` 🔥${disc}% off` : '';
      lines.push(`  ${index}. ${title}\n     ${price}${rating}${discTag}`);
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

  // Cross-platform savings callout
  const withPrice = products.filter((p) => p.price > 0);
  if (withPrice.length > 1) {
    const cheapest = withPrice.reduce((a, b) => (a.price < b.price ? a : b));
    const priciest = withPrice.reduce((a, b) => (a.price > b.price ? a : b));
    const savings = priciest.price - cheapest.price;
    if (savings > 0) {
      const emoji = PLATFORM_EMOJI[cheapest.platform] ?? '🏪';
      const name = cheapest.platform.charAt(0).toUpperCase() + cheapest.platform.slice(1);
      lines.push(
        `🏷️ *Cheapest:* ${emoji} ${name} — saves ₹${savings.toLocaleString('en-IN')} vs most expensive\n`
      );
    }
  }

  for (const row of comparisonTable) {
    lines.push(`*${row.attribute}*`);
    for (const product of products) {
      const value = row.values[product.id] ?? 'N/A';
      const emoji = PLATFORM_EMOJI[product.platform] ?? '🏪';
      const title = truncate(product.title, 28);
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
    ? `${product.rating}/5 (${product.reviewCount.toLocaleString()} reviews)`
    : 'No ratings';
  const disc = discountPercent(product);

  const lines = [
    `${emoji} *${platform}*`,
    `*${product.title}*`,
    `💰 Price: ${price}${disc >= 5 ? ` 🔥${disc}% off` : ''}`,
    `⭐ Rating: ${rating}`,
  ];

  const specEntries = Object.entries(product.specs)
    .filter(([k]) => k !== 'MRP')
    .slice(0, 5);
  if (specEntries.length > 0) {
    lines.push('');
    lines.push('*Specs:*');
    for (const [key, val] of specEntries) {
      lines.push(`  • ${key}: ${val}`);
    }
  }

  const mrp = product.specs['MRP'];
  if (mrp && disc >= 5) {
    lines.push('');
    lines.push(`💸 MRP: ${mrp} · You save ${disc}%`);
  }

  return lines.join('\n');
}

export function formatWishlist(products: Product[]): string {
  if (products.length === 0) {
    return '❤️ Your wishlist is empty. Search for products and tap *Save* to add them!';
  }
  const lines = ['❤️ *Your Wishlist*\n'];
  products.forEach((p, i) => {
    const emoji = PLATFORM_EMOJI[p.platform] ?? '🏪';
    const price = p.price > 0 ? `₹${p.price.toLocaleString('en-IN')}` : 'Price N/A';
    const disc = discountPercent(p);
    const discTag = disc >= 5 ? ` 🔥${disc}% off` : '';
    lines.push(`${i + 1}. ${p.title}\n   ${emoji} ${price}${discTag} ⭐${p.rating}`);
  });
  return lines.join('\n');
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

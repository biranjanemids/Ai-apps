import { sendButtonMessage, sendListMessage, sendTextMessage, ListRow } from './client.js';
import { Product } from '../types/index.js';
import { discountPercent } from '../mcp/tools/searchProducts.js';

const PLATFORM_EMOJI: Record<string, string> = {
  amazon: '🛒',
  flipkart: '🛍',
  myntra: '👗',
};

function discountTag(product: Product): string {
  const disc = discountPercent(product);
  return disc >= 5 ? `🔥 *${disc}% off* MRP` : '';
}

// ── Product card with 3 action buttons ───────────────────────────────────────

export async function sendProductCard(
  to: string,
  product: Product,
  index: number
): Promise<void> {
  const emoji = PLATFORM_EMOJI[product.platform] ?? '🏪';
  const price = product.price > 0 ? `₹${product.price.toLocaleString('en-IN')}` : 'Price N/A';
  const rating = product.rating > 0 ? ` · ⭐${product.rating}` : '';

  const body = [
    `${emoji} *${product.title}*`,
    `💰 ${price}${rating}`,
    Object.entries(product.specs)
      .slice(0, 2)
      .map(([k, v]) => `  • ${k}: ${v}`)
      .join('\n'),
  ]
    .filter(Boolean)
    .join('\n');

  const disc = discountTag(product);
  const bodyWithDisc = disc ? `${body}\n${disc}` : body;

  await sendButtonMessage(
    to,
    bodyWithDisc,
    [
      { id: `buy__${index}__${product.id}__${product.platform}`, title: '💳 Buy Now' },
      { id: `save__${index}__${product.id}__${product.platform}`, title: '❤️ Save' },
      { id: `compare__${index}__${product.id}__${product.platform}`, title: '📊 Compare' },
    ],
    `Product ${index}`,
    `Tap an action below`
  );
}

// ── Search results as a tappable list ────────────────────────────────────────

export async function sendSearchResultsList(
  to: string,
  products: Product[],
  query: string
): Promise<void> {
  if (products.length === 0) {
    await sendTextMessage(to, 'No products found. Try a different search term.');
    return;
  }

  const rows: ListRow[] = products.slice(0, 10).map((p, i) => {
    const emoji = PLATFORM_EMOJI[p.platform] ?? '🏪';
    const price = p.price > 0 ? `₹${p.price.toLocaleString('en-IN')}` : '';
    const rating = p.rating > 0 ? ` ⭐${p.rating}` : '';
    return {
      id: `select__${i + 1}__${p.id}__${p.platform}`,
      title: `${i + 1}. ${p.title}`.slice(0, 24),
      description: `${emoji} ${price}${rating}`.slice(0, 72),
    };
  });

  await sendListMessage(
    to,
    `Found *${products.length}* products for "${query}"\nTap a product to see options:`,
    'View Products',
    'Search Results',
    rows
  );
}

// ── Order summary before checkout ─────────────────────────────────────────────

export async function sendOrderSummary(
  to: string,
  product: Product,
  checkoutUrl: string,
  address: string,
  phone: string
): Promise<void> {
  const emoji = PLATFORM_EMOJI[product.platform] ?? '🏪';
  const platform = product.platform.charAt(0).toUpperCase() + product.platform.slice(1);
  const price = product.price > 0 ? `₹${product.price.toLocaleString('en-IN')}` : 'Check on site';

  const summary = [
    `✅ *Order Summary*`,
    ``,
    `📦 *Product*`,
    `  ${product.title}`,
    ``,
    `${emoji} *Platform:* ${platform}`,
    `💰 *Price:* ${price}`,
    ``,
    `📍 *Delivery Address*`,
    `  ${address}`,
    ``,
    `📱 *Contact:* ${phone}`,
    ``,
    `─────────────────`,
    `🛒 *Tap below to complete your purchase:*`,
    checkoutUrl,
    `─────────────────`,
    `_You'll be taken to ${platform} to confirm payment & delivery details_`,
  ].join('\n');

  await sendTextMessage(to, summary);
}

// ── Checkout link message (simple, no address collected) ──────────────────────

export async function sendCheckoutLink(
  to: string,
  product: Product,
  checkoutUrl: string
): Promise<void> {
  const emoji = PLATFORM_EMOJI[product.platform] ?? '🏪';
  const platform = product.platform.charAt(0).toUpperCase() + product.platform.slice(1);
  const price = product.price > 0 ? `₹${product.price.toLocaleString('en-IN')}` : '';

  const msg = [
    `${emoji} *Ready to buy!*`,
    ``,
    `*${product.title}*`,
    price ? `💰 ${price}` : '',
    ``,
    `👇 *Tap to go directly to checkout:*`,
    checkoutUrl,
    ``,
    `_Opens ${platform} checkout — payment is processed securely by ${platform}_`,
  ]
    .filter((l) => l !== undefined)
    .join('\n');

  await sendButtonMessage(
    to,
    msg.slice(0, 1024),
    [
      { id: `open__${product.id}__${product.platform}`, title: '🛒 Open Checkout' },
      { id: `newSearch__reset`, title: '🔍 New Search' },
    ]
  );
}

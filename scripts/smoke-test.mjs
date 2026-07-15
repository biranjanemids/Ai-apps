// Smoke test — exercises the MCP tools, formatters, and session manager in
// mock mode across all 8 platforms. No network or API keys required.
// Run with: npm test   (builds first, then runs this against dist/)

process.env.USE_MOCK_DATA = 'true';

const { searchProducts } = await import('../dist/mcp/tools/searchProducts.js');
const { compareProducts } = await import('../dist/mcp/tools/compareProducts.js');
const { getProductDetails } = await import('../dist/mcp/tools/getProductDetails.js');
const { getBuyLink } = await import('../dist/mcp/tools/getBuyLink.js');
const {
  formatSearchResults,
  formatComparison,
  formatProductDetail,
  formatWishlist,
} = await import('../dist/whatsapp/messageFormatter.js');
const sm = await import('../dist/agent/sessionManager.js');

const ALL_PLATFORMS = ['amazon', 'flipkart', 'myntra', 'meesho', 'nykaa', 'ajio', 'zepto', 'instamart'];

// A query each platform's mock catalog is expected to answer
const DOMAIN_QUERIES = {
  amazon: 'shoes',
  flipkart: 'shoes',
  myntra: 'shoes',
  meesho: 'kurti',
  nykaa: 'serum',
  ajio: 'jeans',
  zepto: 'milk',
  instamart: 'kids toy',
};

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

// ── 1. Search shape + relevance across all 8 platforms ───────────────────────

const search = await searchProducts({ query: 'shoes', platforms: ALL_PLATFORMS });
check(search.results.length === 8, `expected 8 platform groups, got ${search.results.length}`);
for (const r of search.results) {
  for (const p of r.products) {
    check(p.id && p.platform === r.platform && typeof p.price === 'number',
      `malformed product on ${r.platform}`);
  }
}
check(ALL_PLATFORMS.includes(search.cheapestPlatform), 'cheapestPlatform invalid');
check(ALL_PLATFORMS.includes(search.bestValuePlatform), 'bestValuePlatform invalid');

// Relevance: "shoes" must NOT surface beauty/grocery items anymore
for (const r of search.results) {
  if (['nykaa', 'zepto', 'instamart'].includes(r.platform)) {
    check(r.products.length === 0, `irrelevant results leaked on ${r.platform} for "shoes"`);
  }
}
// "women" must not match a search for "men"
const mens = await searchProducts({ query: "men's pant", platforms: ALL_PLATFORMS });
for (const r of mens.results) {
  for (const p of r.products) {
    check(!/women/i.test(p.title), `"men" matched women's item on ${r.platform}: ${p.title}`);
  }
}

// Budget must be enforced across every platform, whatever the adapter returned
const budgeted = await searchProducts({ query: "men's pant", maxPrice: 3000, platforms: ALL_PLATFORMS });
for (const r of budgeted.results) {
  for (const p of r.products) {
    check(p.price <= 3000, `budget violated on ${r.platform}: ${p.title} @ ${p.price}`);
  }
}
check(budgeted.totalFound > 0, 'budget-filtered search returned nothing');

// ── 2. Per-platform domain search, details + buy link ────────────────────────

const sampleIds = {};
for (const platform of ALL_PLATFORMS) {
  const r = await searchProducts({ query: DOMAIN_QUERIES[platform], platforms: [platform] });
  const products = r.results[0]?.products ?? [];
  check(products.length > 0, `no results for "${DOMAIN_QUERIES[platform]}" on ${platform}`);
  if (products.length === 0) continue;
  sampleIds[platform] = products[0].id;

  const detail = await getProductDetails(products[0].id, platform);
  check(detail?.platform === platform, `getProductDetails failed for ${platform}`);

  const link = await getBuyLink(products[0].id, platform);
  check(typeof link.checkoutUrl === 'string' && link.checkoutUrl.startsWith('http'),
    `getBuyLink bad checkoutUrl for ${platform}`);
}
check((await getProductDetails('NONEXISTENT_XYZ', 'amazon')) === null,
  'expected null for unknown product');

// ── 3. Cross-platform comparison over all 8 ──────────────────────────────────

const compareInput = ALL_PLATFORMS.filter((p) => sampleIds[p])
  .map((p) => ({ productId: sampleIds[p], platform: p }));
const compared = await compareProducts(compareInput);
check(compared.products.length === compareInput.length,
  `compare returned ${compared.products.length}/${compareInput.length} products`);

// ── 4. Formatters render cleanly within WhatsApp limits ──────────────────────

const { text, allProducts } = formatSearchResults(
  search.results, 1, search.cheapestPlatform, search.bestValuePlatform
);
check(allProducts.length === search.totalFound,
  `allProducts ${allProducts.length} != totalFound ${search.totalFound}`);
for (const [label, out] of [
  ['formatSearchResults', text],
  ['formatComparison', formatComparison(compared.products, compared.comparisonTable)],
  ['formatProductDetail', formatProductDetail(allProducts[0])],
  ['formatWishlist', formatWishlist(allProducts.slice(0, 3))],
]) {
  check(!out.includes('undefined') && !out.includes('NaN'), `${label} has undefined/NaN`);
  check(out.length < 4096, `${label} exceeds WhatsApp 4096-char limit`);
}

// ── 5. Session manager: wishlist, language, buy intent, history cap ──────────

const uid = 'smoke-test-user';
const p1 = allProducts[0];
sm.addToWishlist(uid, p1);
sm.addToWishlist(uid, p1);
check(sm.getWishlist(uid).length === 1, 'wishlist dedupe failed');
sm.removeFromWishlist(uid, p1.id, p1.platform);
check(sm.getWishlist(uid).length === 0, 'wishlist removal failed');

check(sm.getPreferredLanguage(uid) === 'en', 'default language not en');
sm.setPreferredLanguage(uid, 'hi');
check(sm.getPreferredLanguage(uid) === 'hi', 'language set failed');

sm.setBuyIntent(uid, { product: p1, checkoutUrl: 'https://x', stage: 'awaiting_address' });
check(sm.getBuyIntent(uid)?.stage === 'awaiting_address', 'buy intent set failed');
sm.clearBuyIntent(uid);
check(sm.getBuyIntent(uid) === undefined, 'buy intent clear failed');

for (let i = 0; i < 25; i++) sm.appendMessage(uid, { role: 'user', content: `m${i}` });
check(sm.getSession(uid).messages.length === 12, 'message history cap failed');

// ── 6. Live-provider plumbing (no network — registry + store mapping) ────────

const { mapStoreToPlatform } = await import('../dist/providers/serpapi.js');
const { registerLiveProduct, getLiveProduct } = await import('../dist/platforms/liveRegistry.js');

check(mapStoreToPlatform('Amazon.in') === 'amazon', 'store mapping failed for Amazon.in');
check(mapStoreToPlatform('Flipkart') === 'flipkart', 'store mapping failed for Flipkart');
check(mapStoreToPlatform('Nykaa') === 'nykaa', 'store mapping failed for Nykaa');
check(mapStoreToPlatform('Swiggy Instamart') === 'instamart', 'store mapping failed for Instamart');
check(mapStoreToPlatform('Croma') === null, 'unknown store should map to null');

const liveP = { ...p1, id: 'serp_test_1', productUrl: 'https://example.com/buy' };
registerLiveProduct(liveP);
check(getLiveProduct('serp_test_1')?.productUrl === 'https://example.com/buy', 'live registry roundtrip failed');
const liveLink = await getBuyLink('serp_test_1', liveP.platform);
check(
  liveLink.checkoutUrl.startsWith('https://example.com/buy') &&
    liveLink.checkoutUrl.includes('utm_source=whatsapp_bot'),
  'live product buy link should be its product URL plus UTM tracking'
);
const liveDetail = await getProductDetails('serp_test_1', liveP.platform);
check(liveDetail?.id === 'serp_test_1', 'live product details lookup failed');

// ── Report ───────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`SMOKE TEST FAILED — ${failures.length} failure(s):`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log('SMOKE TEST PASSED — all 8 platforms, tools, formatters, and session logic OK');
process.exit(0);

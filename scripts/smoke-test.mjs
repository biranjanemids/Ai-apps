// Smoke test — exercises the MCP tools, formatters, and session manager in
// mock mode across all 6 platforms. No network or API keys required.
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

const ALL_PLATFORMS = ['amazon', 'flipkart', 'myntra', 'meesho', 'nykaa', 'ajio'];
const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

// ── 1. Search across all 6 platforms ─────────────────────────────────────────

const search = await searchProducts({ query: 'shoes', platforms: ALL_PLATFORMS });
check(search.results.length === 6, `expected 6 platform groups, got ${search.results.length}`);
for (const r of search.results) {
  check(r.products.length > 0, `no products for ${r.platform}`);
  for (const p of r.products) {
    check(p.id && p.platform === r.platform && typeof p.price === 'number',
      `malformed product on ${r.platform}`);
  }
}
check(ALL_PLATFORMS.includes(search.cheapestPlatform), 'cheapestPlatform invalid');
check(ALL_PLATFORMS.includes(search.bestValuePlatform), 'bestValuePlatform invalid');

// ── 2. Details + buy link per platform ───────────────────────────────────────

const sampleIds = {};
for (const r of search.results) sampleIds[r.platform] = r.products[0].id;

for (const platform of ALL_PLATFORMS) {
  const id = sampleIds[platform];
  const detail = await getProductDetails(id, platform);
  check(detail?.platform === platform, `getProductDetails failed for ${platform}`);

  const link = await getBuyLink(id, platform);
  check(typeof link.checkoutUrl === 'string' && link.checkoutUrl.startsWith('http'),
    `getBuyLink bad checkoutUrl for ${platform}`);
}
check((await getProductDetails('NONEXISTENT_XYZ', 'amazon')) === null,
  'expected null for unknown product');

// ── 3. Cross-platform comparison ─────────────────────────────────────────────

const compared = await compareProducts(
  ALL_PLATFORMS.map((p) => ({ productId: sampleIds[p], platform: p }))
);
check(compared.products.length === 6, `compare returned ${compared.products.length}/6 products`);

// ── 4. Formatters render cleanly within WhatsApp limits ──────────────────────

const { text, allProducts } = formatSearchResults(
  search.results, 1, search.cheapestPlatform, search.bestValuePlatform
);
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
check(sm.getSession(uid).messages.length === 20, 'message history cap failed');

// ── Report ───────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`SMOKE TEST FAILED — ${failures.length} failure(s):`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log('SMOKE TEST PASSED — all 6 platforms, tools, formatters, and session logic OK');
process.exit(0);

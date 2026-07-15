// ── Affiliate link wrapping ───────────────────────────────────────────────────
// Turns store URLs into commission-earning links. Two mechanisms:
//
// 1. Amazon Associates: append `tag=` to amazon.in URLs (AMAZON_AFFILIATE_TAG).
// 2. Cuelinks: wrap the URL in their redirect for every other supported store
//    (CUELINKS_CID). Cuelinks covers Flipkart, Myntra, Ajio, Nykaa, Meesho and
//    1,000+ Indian merchants with one ID — sign up at https://www.cuelinks.com.
//
// EarnKaro profit links can only be generated in their app/dashboard (no public
// deep-link API), so they can't be automated here — use Cuelinks for the bot.
//
// Everything is env-gated: with no env vars set, URLs pass through unchanged.

const CUELINKS_REDIRECT = 'https://linksredirect.com/';

// Merchants Cuelinks reliably tracks. Quick-commerce (zepto/instamart) mostly
// converts in-app, so wrapping those adds a redirect hop for little payout —
// leave them direct.
const CUELINKS_PLATFORMS = new Set(['flipkart', 'myntra', 'ajio', 'nykaa', 'meesho']);

function amazonTag(): string {
  return process.env.AMAZON_AFFILIATE_TAG ?? '';
}

function cuelinksCid(): string {
  return process.env.CUELINKS_CID ?? '';
}

export function isAffiliateEnabled(): boolean {
  return Boolean(amazonTag() || cuelinksCid());
}

export function wrapAffiliateLink(url: string, platform: string): string {
  if (!url?.startsWith('http')) return url;

  if (platform === 'amazon') {
    const tag = amazonTag();
    if (!tag) return url;
    if (/[?&]tag=/.test(url)) return url; // already tagged
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}tag=${encodeURIComponent(tag)}`;
  }

  const cid = cuelinksCid();
  if (cid && CUELINKS_PLATFORMS.has(platform)) {
    if (url.startsWith(CUELINKS_REDIRECT)) return url; // already wrapped
    return `${CUELINKS_REDIRECT}?cid=${encodeURIComponent(cid)}&source=linkkit&url=${encodeURIComponent(url)}`;
  }

  return url;
}

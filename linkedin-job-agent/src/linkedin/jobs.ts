import type { Locator, Page } from 'playwright';
import { env, type Settings } from '../config.js';
import { fixTitle, type JobDetails } from '../matching.js';
import { pause } from './browser.js';

export function searchUrl(keyword: string, settings: Settings, start = 0): string {
  const p = new URLSearchParams({
    keywords: fixTitle(keyword),
    location: env.location,
    geoId: env.geoId,
    f_TPR: settings.postedWithin,
    sortBy: 'R',
    start: String(start),
  });
  if (settings.applyMode === 'easy') p.set('f_AL', 'true'); // Easy Apply only
  return `https://www.linkedin.com/jobs/search/?${p}`;
}

const GUEST = 'https://www.linkedin.com/jobs-guest/jobs/api';

/**
 * GET a LinkedIn URL from inside the browser tab, so it carries the same cookies and browser
 * identity as normal browsing. Returns null on any failure.
 */
async function fetchText(page: Page, url: string): Promise<string | null> {
  if (!/^https:\/\/www\.linkedin\.com\//.test(page.url())) {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }
  return page
    .evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      return r.ok ? r.text() : null;
    }, url)
    .catch(() => null);
}

/** Job IDs found anywhere in a chunk of LinkedIn HTML/JSON (independent of page layout). */
export function extractJobIds(html: string): string[] {
  const ids = new Set<string>();
  const patterns = [
    /urn:li:(?:fs_|fsd_)?jobPosting:(\d{6,})/g,
    /\/jobs\/view\/(?:[^"'?\s]*?-)?(\d{6,})/g,
    /data-(?:occludable-)?job-id="(\d{6,})"/g,
    /currentJobId=(\d{6,})/g,
  ];
  for (const re of patterns) for (const m of html.matchAll(re)) ids.add(m[1]);
  return [...ids];
}

/**
 * Job IDs for one keyword. Uses LinkedIn's public job-listing feed first (plain HTML that
 * hasn't changed in years), then falls back to the logged-in search page.
 */
export async function searchJobIds(
  page: Page,
  keyword: string,
  settings: Settings,
  limit: number,
): Promise<{ ids: string[]; source: string }> {
  const ids = new Set<string>();
  const params = new URL(searchUrl(keyword, settings)).searchParams;
  for (let start = 0; ids.size < limit && start < 300; ) {
    params.set('start', String(start));
    const body = await fetchText(page, `${GUEST}/seeMoreJobPostings/search?${params}`);
    if (body === null) break;
    const found = extractJobIds(body);
    const before = ids.size;
    found.forEach((id) => ids.add(id));
    if (!found.length || ids.size === before) break;
    start += found.length;
    await pause(800, 1600);
  }
  if (ids.size) return { ids: [...ids].slice(0, limit), source: 'job feed' };

  // Fallback: the logged-in search page, reading IDs from its HTML
  for (let start = 0; ids.size < limit && start < 250; start += 25) {
    const ok = await page.goto(searchUrl(keyword, settings, start), { waitUntil: 'domcontentloaded', timeout: 60000 }).then(() => true, () => false);
    if (!ok) break;
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 1500);
      await pause(500, 900);
    }
    const before = ids.size;
    extractJobIds(await page.content()).forEach((id) => ids.add(id));
    if (ids.size === before) break;
    await pause(1500, 3000);
  }
  return { ids: [...ids].slice(0, limit), source: 'search page' };
}

const firstText = async (page: Page, selectors: string[]): Promise<string> => {
  for (const s of selectors) {
    const t = await page.locator(s).first().innerText({ timeout: 1500 }).catch(() => '');
    if (t.trim()) return t.trim();
  }
  return '';
};

interface GuestPosting {
  title: string;
  company: string;
  location: string;
  description: string;
  externalUrl: string;
}

/** Title/company/location/description from LinkedIn's public job page for this ID. */
async function guestPosting(page: Page, id: string): Promise<GuestPosting | null> {
  const html = await fetchText(page, `${GUEST}/jobPosting/${id}`);
  if (!html) return null;
  return page.evaluate((h) => {
    const d = new DOMParser().parseFromString(h, 'text/html');
    const t = (sel: string) => ((d.querySelector(sel) as HTMLElement | null)?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const desc = d.querySelector('.show-more-less-html__markup, .description__text, .decorated-job-posting__details');
    const applyUrl = (d.querySelector('code#applyUrl')?.innerHTML ?? '').match(/"(https?:[^"]+)"/)?.[1] ?? '';
    return {
      title: t('.top-card-layout__title, .topcard__title, h2'),
      company: t('.topcard__org-name-link, a[data-tracking-control-name*="org-name"], .topcard__flavor'),
      location: t('.topcard__flavor--bullet'),
      description: ((desc as HTMLElement | null)?.innerText || desc?.textContent || '').trim(),
      externalUrl: applyUrl ? decodeURIComponent(applyUrl.replace(/&amp;/g, '&')) : '',
    };
  }, html).catch(() => null);
}

export async function jobDetails(page: Page, id: string): Promise<JobDetails> {
  const url = `https://www.linkedin.com/jobs/view/${id}/`;
  const guest = await guestPosting(page, id);

  // The logged-in page tells us which apply button you get, and whether you already applied
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
  await applyButton(page).waitFor({ timeout: 15000 }).catch(() => {});
  await pause(800, 1500);
  await page.locator('button[aria-label*="see more" i], .jobs-description__footer-button').first().click({ timeout: 1500 }).catch(() => {});

  // Page title is "Job title | Company | LinkedIn" — a layout-proof fallback
  const titleParts = (await page.title().catch(() => '')).replace(/^\(\d+\+?\)\s*/, '').split(' | ');
  const title =
    guest?.title ||
    (await firstText(page, ['.job-details-jobs-unified-top-card__job-title h1', '.jobs-unified-top-card h1', 'main h1', 'h1'])) ||
    (titleParts.length >= 3 ? titleParts[0] : '');
  const company =
    guest?.company ||
    (
      await firstText(page, [
        '.job-details-jobs-unified-top-card__company-name a',
        '.job-details-jobs-unified-top-card__company-name',
        '.jobs-unified-top-card__company-name',
        'main a[href*="/company/"]:not(:has(img))',
      ])
    ).split('\n')[0] ||
    (titleParts.length >= 3 ? titleParts[1] : '');
  const topCard = await firstText(page, [
    '.job-details-jobs-unified-top-card__primary-description-container',
    '.job-details-jobs-unified-top-card__tertiary-description-container',
    '.jobs-unified-top-card__subtitle-primary-grouping',
  ]);
  let description =
    (guest?.description && guest.description.length > 200 ? guest.description : '') ||
    (await firstText(page, ['#job-details', '.jobs-description__content', '.jobs-box__html-content', '.description__text', '[class*="jobs-description"]'])) ||
    guest?.description ||
    '';
  if (description.length < 200) {
    // Layout-proof fallback: the page's visible text from "About the job" onwards
    const text = await page
      .locator('main')
      .first()
      .innerText({ timeout: 5000 })
      .catch(() => page.locator('body').innerText().catch(() => ''));
    const at = text.search(/about the job|job description|about the role|about this role|responsibilities/i);
    const fromPage = (at >= 0 ? text.slice(at) : text).slice(0, 15000);
    if (fromPage.length > description.length) description = fromPage;
  }

  const applyBtn = await findApplyButton(page);
  const applyText = applyBtn
    ? (await applyBtn.innerText().catch(() => '')) + ' ' + ((await applyBtn.getAttribute('aria-label').catch(() => '')) ?? '')
    : '';
  const easyApply = /easy apply/i.test(applyText);
  const externalApply = !easyApply && (/\bapply\b/i.test(applyText) || Boolean(guest?.externalUrl));
  const closed = await page
    .getByText(/no longer accepting applications|applications (are )?closed|this job is no longer available/i)
    .first()
    .isVisible()
    .catch(() => false);
  const alreadyApplied = await page
    .locator('.artdeco-inline-feedback--success, .post-apply-timeline, [class*="applied"]')
    .filter({ hasText: /^\s*applied\b/i })
    .count()
    .then((n) => n > 0)
    .catch(() => false);

  return {
    id,
    url,
    title: title.trim(),
    company: company.trim(),
    location: (guest?.location || topCard.split('·')[0]).trim(),
    description,
    easyApply,
    externalApply,
    externalUrl: guest?.externalUrl || undefined,
    alreadyApplied,
    closed,
  };
}

/** The job's main apply control: Easy Apply, or "Apply" that opens the company's site. */
export const applyButton = (page: Page) =>
  page
    .locator(
      'button.jobs-apply-button, a.jobs-apply-button, button[aria-label*="Easy Apply" i], a[aria-label*="Easy Apply" i], button[aria-label^="Apply" i], a[aria-label^="Apply" i], a[href*="/apply/?openSDUIApplyFlow"]',
    )
    .or(page.getByRole('button', { name: /^\s*(easy apply|apply)\b/i }))
    .or(page.getByRole('link', { name: /^\s*(easy apply|apply)\b/i }))
    .first();

/**
 * The visible apply control for THIS job, most specific first, so a "Easy Apply" search
 * filter or a similar-jobs card elsewhere on the page is never clicked by mistake.
 */
export async function findApplyButton(page: Page): Promise<Locator | null> {
  const candidates = [
    page.locator('[aria-label^="Easy Apply to" i]'),
    page.locator('[aria-label*="Apply to" i][aria-label*="website" i]'),
    page.locator('[aria-label^="Apply to" i]'),
    page.locator('.jobs-apply-button'),
    page.locator('a[href*="/apply/"], a[href*="externalApply"], a[href*="/redir/redirect"]').filter({ hasText: /apply/i }),
    page.getByRole('button', { name: /^\s*(easy apply|apply)\s*$/i }),
    page.getByRole('link', { name: /^\s*(easy apply|apply)\s*$/i }),
  ];
  for (const c of candidates) {
    for (const el of await c.all().catch(() => [])) {
      if (!(await el.isVisible().catch(() => false))) continue;
      // Search filters ("Easy Apply" chip) and page chrome aren't this job's apply button
      const chrome = await el
        .evaluate((e) => !!e.closest('nav, [role="search"], [class*="search-reusables__filter"], [class*="search-filter"], [aria-label*="search filters" i]'))
        .catch(() => false);
      if (!chrome) return el;
    }
  }
  // Fallback: the broader match that worked before (LinkedIn's markup varies)
  for (const el of await applyButton(page).all().catch(() => [])) {
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

/** Where an apply link points, unwrapping LinkedIn's redirect links. */
export async function applyHref(el: Locator): Promise<string | undefined> {
  const href = await el.getAttribute('href').catch(() => null);
  if (!href) return undefined;
  try {
    const u = new URL(href, 'https://www.linkedin.com');
    const wrapped = u.searchParams.get('url');
    if (wrapped) return decodeURIComponent(wrapped);
    return /linkedin\.com$/.test(u.hostname) ? undefined : u.toString();
  } catch {
    return undefined;
  }
}

/** LinkedIn sometimes shows a "share your profile" / job-safety reminder before applying. */
export async function passInterstitials(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const dlg = page.locator('div[role="dialog"], div[role="alertdialog"]').filter({ hasNot: page.locator('input, textarea, select') }).first();
    if (!(await dlg.isVisible({ timeout: 2500 }).catch(() => false))) return;
    const go = dlg.locator('button, a').filter({ hasText: /^\s*(continue( applying| to (apply|application|site|company website))?|apply( anyway)?|i understand|got it|ok)\s*$/i }).first();
    if (!(await go.isVisible().catch(() => false))) return;
    await go.click().catch(() => {});
    await pause(800, 1500);
  }
}

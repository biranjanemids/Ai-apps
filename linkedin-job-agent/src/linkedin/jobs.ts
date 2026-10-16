import type { Page } from 'playwright';
import { env, type Settings } from '../config.js';
import type { JobDetails } from '../matching.js';
import { pause } from './browser.js';

export function searchUrl(keyword: string, settings: Settings, start = 0): string {
  const p = new URLSearchParams({
    keywords: keyword,
    location: env.location,
    geoId: env.geoId,
    f_TPR: settings.postedWithin,
    sortBy: 'R',
    start: String(start),
  });
  if (settings.applyMode === 'easy') p.set('f_AL', 'true'); // Easy Apply only
  return `https://www.linkedin.com/jobs/search/?${p}`;
}

/** Job IDs from the Easy Apply search results for one keyword, newest pages first. */
export async function searchJobIds(page: Page, keyword: string, settings: Settings, limit: number): Promise<string[]> {
  const ids = new Set<string>();
  for (let start = 0; ids.size < limit && start < 250; start += 25) {
    await page.goto(searchUrl(keyword, settings, start), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-job-id], a[href*="/jobs/view/"]', { timeout: 15000 }).catch(() => {});
    // the results pane lazy-loads as you scroll
    const list = page.locator('.jobs-search-results-list, .scaffold-layout__list').first();
    for (let i = 0; i < 6; i++) {
      await list.evaluate((el) => el.scrollBy(0, 1200)).catch(() => page.mouse.wheel(0, 1200));
      await pause(400, 800);
    }
    const found = await page.$$eval('[data-job-id], [data-occludable-job-id], a[href*="/jobs/view/"]', (els) =>
      els.map(
        (e) =>
          e.getAttribute('data-job-id') ||
          e.getAttribute('data-occludable-job-id') ||
          (e.getAttribute('href') ?? '').match(/\/jobs\/view\/(\d+)/)?.[1] ||
          '',
      ),
    );
    const before = ids.size;
    found.filter((id) => /^\d+$/.test(id)).forEach((id) => ids.add(id));
    if (ids.size === before) break; // no more results
    await pause(1500, 3000);
  }
  return [...ids].slice(0, limit);
}

const firstText = async (page: Page, selectors: string[]): Promise<string> => {
  for (const s of selectors) {
    const t = await page.locator(s).first().innerText({ timeout: 1500 }).catch(() => '');
    if (t.trim()) return t.trim();
  }
  return '';
};

export async function jobDetails(page: Page, id: string): Promise<JobDetails> {
  const url = `https://www.linkedin.com/jobs/view/${id}/`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1', { timeout: 20000 }).catch(() => {});
  await pause(800, 1500);
  // expand "…see more" so the full description (and experience requirement) is readable
  await page.locator('button[aria-label*="see more" i], .jobs-description__footer-button').first().click({ timeout: 1500 }).catch(() => {});

  const title = await firstText(page, ['.job-details-jobs-unified-top-card__job-title h1', '.jobs-unified-top-card h1', 'main h1', 'h1']);
  const company = (
    await firstText(page, [
      '.job-details-jobs-unified-top-card__company-name a',
      '.job-details-jobs-unified-top-card__company-name',
      '.jobs-unified-top-card__company-name',
      'main a[href*="/company/"]:not(:has(img))',
    ])
  ).split('\n')[0];
  const topCard = await firstText(page, [
    '.job-details-jobs-unified-top-card__primary-description-container',
    '.job-details-jobs-unified-top-card__tertiary-description-container',
    '.jobs-unified-top-card__subtitle-primary-grouping',
  ]);
  const description = await firstText(page, ['#job-details', '.jobs-description__content', '.jobs-box__html-content', '.description__text']);
  const applyBtn = applyButton(page);
  const applyText = (await applyBtn.count())
    ? (await applyBtn.innerText().catch(() => '')) + ' ' + ((await applyBtn.getAttribute('aria-label').catch(() => '')) ?? '')
    : '';
  const easyApply = /easy apply/i.test(applyText);
  const externalApply = !easyApply && /\bapply\b/i.test(applyText);
  const alreadyApplied = await page.locator('.artdeco-inline-feedback--success, .post-apply-timeline').filter({ hasText: /applied/i }).count().then((n) => n > 0).catch(() => false);

  return { id, url, title, company, location: topCard.split('·')[0].trim(), description, easyApply, externalApply, alreadyApplied };
}

/** The job's main apply control: Easy Apply, or "Apply" that opens the company's site. */
export const applyButton = (page: Page) =>
  page
    .locator(
      'button.jobs-apply-button, a.jobs-apply-button, button[aria-label*="Easy Apply" i], button[aria-label^="Apply" i], a[aria-label^="Apply" i]',
    )
    .first();

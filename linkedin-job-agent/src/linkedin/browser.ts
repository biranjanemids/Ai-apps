import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { DATA_DIR, env } from '../config.js';

const USER_DATA = path.join(DATA_DIR, 'browser-profile');

/** Persistent Chromium profile so your LinkedIn login survives restarts. */
export async function openBrowser(opts: { headless?: boolean } = {}): Promise<BrowserContext> {
  const ctx = await chromium.launchPersistentContext(USER_DATA, {
    headless: opts.headless ?? env.headless,
    executablePath: env.chromePath,
    viewport: { width: 1280, height: 900 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  if (env.liAt) {
    await ctx.addCookies([
      { name: 'li_at', value: env.liAt, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' },
    ]);
  }
  return ctx;
}

export async function isLoggedIn(page: Page): Promise<boolean> {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  return !/\/(login|authwall|checkpoint|uas)/.test(page.url());
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Human-ish pause; LinkedIn rate-limits accounts that act too fast. */
export const pause = (minMs: number, maxMs: number) => sleep(minMs + Math.random() * (maxMs - minMs));

/** De-duplicated visible lines of an element (LinkedIn repeats text for screen readers). */
export function cleanLines(text: string): string[] {
  const out: string[] = [];
  for (const l of text.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (out[out.length - 1] !== l) out.push(l);
  }
  return out;
}

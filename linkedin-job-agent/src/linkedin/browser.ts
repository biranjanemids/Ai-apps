import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { DATA_DIR, env } from '../config.js';

const USER_DATA = path.join(DATA_DIR, 'browser-profile');

/** Persistent Chromium profile so your LinkedIn login survives restarts. */
export async function openBrowser(
  opts: { headless?: boolean; viewport?: { width: number; height: number } } = {},
): Promise<BrowserContext> {
  const args = ['--disable-blink-features=AutomationControlled'];
  // Termux's Chromium can't use the Linux sandbox and has a tiny /dev/shm
  if (process.platform === 'android') args.push('--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu');
  const ctx = await chromium.launchPersistentContext(USER_DATA, {
    headless: opts.headless ?? env.headless,
    executablePath: env.chromePath,
    viewport: opts.viewport ?? { width: 1280, height: 900 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    args,
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
  const ok = !/\/(login|authwall|checkpoint|uas|signup)/.test(page.url());
  setSession(ok);
  return ok;
}

const SESSION_FILE = path.join(DATA_DIR, 'session.json');

/** Last known LinkedIn login state, so the dashboard can show it without opening a browser. */
export function getSession(): { loggedIn: boolean; at: string } | null {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function setSession(loggedIn: boolean): void {
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ loggedIn, at: new Date().toISOString() }));
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

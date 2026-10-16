import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { DATA_DIR, env } from '../config.js';

const USER_DATA = path.join(DATA_DIR, 'browser-profile');

let cachedUA: string | undefined;

/**
 * Headless Chromium announces itself as "HeadlessChrome", which LinkedIn may answer with
 * a blank or blocked page. Present the same browser as regular desktop Chrome instead.
 */
export function userAgent(): string {
  if (cachedUA) return cachedUA;
  let version = '130.0.0.0';
  try {
    const exe = env.chromePath ?? chromium.executablePath();
    const out = execFileSync(exe, ['--version'], { timeout: 15000, encoding: 'utf8' });
    version = out.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1] ?? version;
  } catch {
    // keep the fallback version
  }
  cachedUA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  return cachedUA;
}

let contextHook: ((ctx: BrowserContext) => Promise<void>) | null = null;
/** Tests use this to serve mock LinkedIn pages to the agent's browser. */
export const setContextHookForTests = (fn: typeof contextHook) => (contextHook = fn);

/** Persistent Chromium profile so your LinkedIn login survives restarts. */
export async function openBrowser(
  opts: { headless?: boolean; viewport?: { width: number; height: number }; lite?: boolean } = {},
): Promise<BrowserContext> {
  const args = ['--disable-blink-features=AutomationControlled'];
  if (process.platform === 'android') {
    // Termux's Chromium can't use the Linux sandbox and has a tiny /dev/shm; keep memory low
    // so Android doesn't kill the browser mid-run
    args.push(
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--renderer-process-limit=2', '--disable-extensions', '--disable-background-networking',
      '--js-flags=--max-old-space-size=384',
    );
  }
  const ctx = await chromium.launchPersistentContext(USER_DATA, {
    headless: opts.headless ?? env.headless,
    executablePath: env.chromePath,
    viewport: opts.viewport ?? { width: 1280, height: 900 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    userAgent: userAgent(),
    args,
  });
  if (opts.lite) {
    // Pictures, video and fonts aren't needed to read jobs or fill forms — skipping them
    // cuts memory and mobile data a lot
    await ctx.route('**/*', (route) => {
      const t = route.request().resourceType();
      return t === 'image' || t === 'media' || t === 'font' ? route.abort() : route.continue();
    });
  }
  if (contextHook) await contextHook(ctx);
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
  // Need both: the session cookie, and LinkedIn not bouncing us to a login/checkpoint page
  const hasCookie = (await page.context().cookies('https://www.linkedin.com')).some((c) => c.name === 'li_at');
  const ok = hasCookie && !/\/(login|authwall|checkpoint|uas|signup)/.test(page.url());
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
export const pause = (minMs: number, maxMs: number) => sleep((minMs + Math.random() * (maxMs - minMs)) * pauseScale);
let pauseScale = 1;
/** Tests shrink the human-like pauses. */
export const setPauseScaleForTests = (f: number) => (pauseScale = f);

/** De-duplicated visible lines of an element (LinkedIn repeats text for screen readers). */
export function cleanLines(text: string): string[] {
  const out: string[] = [];
  for (const l of text.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (out[out.length - 1] !== l) out.push(l);
  }
  return out;
}

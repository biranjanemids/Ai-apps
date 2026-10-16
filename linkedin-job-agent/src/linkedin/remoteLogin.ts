import type { BrowserContext, Page } from 'playwright';
import { isLoggedIn, openBrowser, setSession } from './browser.js';

/**
 * Log in to LinkedIn from the phone dashboard: the headless browser's screen is streamed
 * as screenshots and your taps/typing are replayed into it. Works for 2FA codes, app
 * approvals and captchas, and your password is never stored — only the session cookie.
 */
export const VIEWPORT = { width: 400, height: 760 };
const IDLE_TIMEOUT_MS = 10 * 60_000;

let ctx: BrowserContext | null = null;
let page: Page | null = null;
let idleTimer: NodeJS.Timeout | null = null;

function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void stop(), IDLE_TIMEOUT_MS);
}

export const loginActive = () => page !== null;

export async function start(): Promise<void> {
  if (!page) {
    ctx = await openBrowser({ viewport: VIEWPORT });
    page = ctx.pages()[0] ?? (await ctx.newPage());
  }
  touch();
  // On a network error keep the browser open: the phone shows Chrome's error page
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' }).catch(() => {});
}

function active(): Page {
  if (!page) throw new Error('No login in progress');
  touch();
  return page;
}

export async function screenshot(): Promise<Buffer> {
  return active().screenshot({ type: 'jpeg', quality: 70 });
}

export async function tap(x: number, y: number): Promise<void> {
  const p = active();
  await p.mouse.click(Math.round(x * VIEWPORT.width), Math.round(y * VIEWPORT.height));
  await p.waitForTimeout(600);
}

export async function type(text: string): Promise<void> {
  await active().keyboard.type(text, { delay: 40 });
}

const KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape']);
export async function press(key: string): Promise<void> {
  if (!KEYS.has(key)) throw new Error('unsupported key');
  const p = active();
  await p.keyboard.press(key);
  await p.waitForTimeout(800);
}

export async function scroll(dy: number): Promise<void> {
  await active().mouse.wheel(0, Math.max(-2000, Math.min(2000, dy)));
}

/** Checks whether login succeeded and closes the browser so the agent can use the profile. */
export async function finish(): Promise<boolean> {
  const p = active();
  const ok = /linkedin\.com\/(feed|in\/|jobs|mynetwork)/.test(p.url()) || (await isLoggedIn(p));
  setSession(ok);
  await stop();
  return ok;
}

export async function stop(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const c = ctx;
  ctx = null;
  page = null;
  await c?.close().catch(() => {});
}

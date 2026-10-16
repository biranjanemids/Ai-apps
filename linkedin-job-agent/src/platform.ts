/**
 * Must be the first import of the entry point. On Android (Termux) Playwright throws
 * "Unsupported platform" while loading unless PLAYWRIGHT_BROWSERS_PATH is set, and it has
 * no bundled browser — we use Termux's own Chromium instead.
 */
import 'dotenv/config';
import fs from 'node:fs';

export const isAndroid = process.platform === 'android';

if (isAndroid) {
  const prefix = process.env.PREFIX ?? '/data/data/com.termux/files/usr';
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= `${prefix}/var/lib/ms-playwright`;
  if (!process.env.CHROME_PATH) {
    const found = ['chromium-browser', 'chromium'].map((b) => `${prefix}/bin/${b}`).find((p) => fs.existsSync(p));
    if (found) process.env.CHROME_PATH = found;
  }
  // Only the phone itself needs to reach the dashboard
  process.env.HOST ??= '127.0.0.1';
}

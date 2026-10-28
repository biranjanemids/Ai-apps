import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Page } from 'playwright';
import { mailAccess } from './config.js';

/**
 * Job portals often send "verify your email" links or one-time codes. With an app password
 * for your inbox (dashboard → Email access), the agent reads that email and finishes the
 * step itself. It only looks at recent mail that is about verification.
 */

export interface Verification {
  link?: string;
  code?: string;
}

const ABOUT_VERIFY = /verif|activat|confirm|one[- ]time|passcode|\botp\b|security code|sign[- ]?in code|validate|complete your (registration|account)/i;

/** Pulls a verification link or code out of an email. `hint` is the company or portal name. */
export function extractVerification(mail: { subject?: string; from?: string; text?: string; html?: string }, hint: string): Verification | null {
  const subject = mail.subject ?? '';
  const text = mail.text ?? '';
  const html = mail.html ?? '';
  const all = `${mail.from ?? ''} ${subject} ${text}`;
  if (!ABOUT_VERIFY.test(`${subject} ${text.slice(0, 2000)}`)) return null;
  const words = hint.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const related = !words.length || words.some((w) => all.toLowerCase().includes(w) || html.toLowerCase().includes(w));
  if (!related) return null;

  const urls = [
    ...[...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1].replace(/&amp;/g, '&')),
    ...[...text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map((m) => m[0]),
  ].filter((u) => /^https?:/i.test(u));
  const link = urls.find((u) => /verif|activat|confirm|validat|token=|passwordless|emailverification|registration/i.test(u) && !/unsubscribe|privacy|preferences/i.test(u));
  if (link) return { link };

  const code =
    text.match(/(?:code|otp|pin|passcode)\D{0,40}?\b(\d{4,8})\b/i)?.[1] ??
    text.match(/\b(\d{4,8})\b\s+is your/i)?.[1] ??
    subject.match(/\b(\d{4,8})\b/)?.[1];
  if (code) return { code };
  return null;
}

async function checkInbox(since: Date, hint: string): Promise<Verification | null> {
  const acc = mailAccess();
  if (!acc) return null;
  const client = new ImapFlow({ host: acc.host, port: 993, secure: true, auth: { user: acc.user, pass: acc.pass }, logger: false });
  await client.connect();
  try {
    for (const box of ['INBOX', '[Gmail]/Spam', 'Junk', 'Spam']) {
      const lock = await client.getMailboxLock(box).catch(() => null);
      if (!lock) continue;
      try {
        // IMAP "SINCE" is a whole day, so filter by arrival time below
        const uids = (await client.search({ since: new Date(since.getTime() - 86400e3) }, { uid: true })) || [];
        for (const uid of uids.slice(-20).reverse()) {
          const msg = await client.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true });
          if (!msg || !msg.source) continue;
          if (msg.internalDate && new Date(msg.internalDate).getTime() < since.getTime() - 120e3) continue;
          const mail = await simpleParser(msg.source);
          const found = extractVerification(
            { subject: mail.subject, from: mail.from?.text, text: mail.text, html: typeof mail.html === 'string' ? mail.html : '' },
            hint,
          );
          if (found) return found;
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return null;
}

/** Waits (up to 3 min) for the verification email that arrived after `since`. */
export async function waitForVerification(since: Date, hint: string, timeoutMs = 180000): Promise<Verification | null> {
  if (!mailAccess()) return null;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const found = await checkInbox(since, hint).catch(() => null);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 15000));
  }
  return null;
}

/**
 * Finishes an email verification on `site`: opens the emailed link in a new tab, or types the
 * emailed code. Returns what it did, or null if no email came.
 */
export async function confirmByEmail(site: Page, hint: string, since: Date): Promise<'link' | 'code' | null> {
  const v = await waitForVerification(since, hint);
  if (!v) return null;
  if (v.link) {
    const tab = await site.context().newPage();
    try {
      await tab.goto(v.link, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await tab.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
      await tab.waitForTimeout(3000);
    } catch {
      return null;
    } finally {
      await tab.close().catch(() => {});
    }
    return 'link';
  }
  const box = site
    .locator('input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i], input[name*="otp" i], input[id*="otp" i], input[aria-label*="code" i]')
    .or(site.locator('input[type="text"], input[type="tel"], input[type="number"]'))
    .first();
  if (!(await box.isVisible().catch(() => false))) return null;
  await box.fill(v.code!);
  const go = site.locator('button, input[type="submit"]').filter({ hasText: /verify|submit|continue|confirm|next|sign ?in/i }).first();
  if (await go.isVisible().catch(() => false)) await go.click().catch(() => {});
  else await box.press('Enter').catch(() => {});
  await site.waitForLoadState('domcontentloaded').catch(() => {});
  await site.waitForTimeout(2500);
  return 'code';
}

/** Dashboard "Test" button: can we log in to the inbox? */
export async function mailHealth(): Promise<{ ok: boolean; detail: string }> {
  const acc = mailAccess();
  if (!acc) return { ok: false, detail: 'not set up' };
  const client = new ImapFlow({ host: acc.host, port: 993, secure: true, auth: { user: acc.user, pass: acc.pass }, logger: false });
  try {
    await client.connect();
    const status = await client.status('INBOX', { messages: true });
    return { ok: true, detail: `${acc.user} on ${acc.host} — ${status.messages ?? 0} emails in inbox` };
  } catch (e) {
    return { ok: false, detail: `${acc.host}: ${(e as Error).message.slice(0, 120)}` };
  } finally {
    await client.logout().catch(() => {});
  }
}

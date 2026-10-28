import type { BrowserContext, Page } from 'playwright';
import { env, portalPassword } from '../config.js';
import { aiEnabled, aiNextActions, type PageAction } from '../ai.js';
import type { QuestionContext } from '../answers.js';
import { confirmByEmail } from '../mail.js';
import { pause } from './browser.js';
import type { ApplyResult } from './easyApply.js';
import { coverLetterPdf, hasBlockingCaptcha, SUCCESS } from './externalApply.js';
import { trailClick } from './siteMemory.js';

/**
 * The fallback for any careers site the agent has no built-in support for — including ones
 * that don't exist yet. Each step it reads the page as a numbered list of fields and buttons,
 * the AI decides what to fill and click (from your resume and answers only), and the agent
 * does it. Captchas still stop it; email verification is handled when Email access is set.
 */

const MARK = 'data-ja';

type FrameShot = { head: string; fields: string[]; buttons: string[]; next: number };

/**
 * Numbers every visible field and button and describes them in one line each — including
 * those inside embedded frames (iCIMS, some login pages and many older career sites use them).
 */
async function snapshot(site: Page): Promise<string> {
  let next = 0;
  let head = '';
  const fields: string[] = [];
  const buttons: string[] = [];
  for (const frame of site.frames()) {
    const main = frame === site.mainFrame();
    const shot = await frame.evaluate(shootFrame, { MARK, start: next }).catch(() => null);
    if (!shot) continue;
    next = shot.next;
    const where = main ? '' : ` (inside embedded frame ${(() => { try { return new URL(frame.url()).host; } catch { return ''; } })()})`;
    if (main) head = shot.head;
    fields.push(...shot.fields.map((f) => f + where));
    buttons.push(...shot.buttons.map((b) => b + where));
    if (next >= 120) break;
  }
  return [head, `FIELDS:\n${fields.join('\n') || '(none)'}`, `BUTTONS & LINKS:\n${buttons.join('\n') || '(none)'}`].join('\n');
}

/** Runs inside one frame: marks and describes its fields and buttons, numbering from `start`. */
function shootFrame({ MARK, start }: { MARK: string; start: number }): FrameShot {
  {
    document.querySelectorAll(`[${MARK}]`).forEach((e) => e.removeAttribute(MARK));
    const shown = (e: Element) => {
      const r = (e as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(e as HTMLElement);
      return (r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none') || (e as HTMLInputElement).type === 'file';
    };
    const clean = (t: string | null | undefined, n = 80) => (t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    const labelOf = (e: HTMLElement) => {
      let t = '';
      if (e.id) t = (document.querySelector(`label[for="${CSS.escape(e.id)}"]`) as HTMLElement | null)?.innerText ?? '';
      if (!t) t = (e.closest('label') as HTMLElement | null)?.innerText ?? '';
      if (!t) t = e.getAttribute('aria-label') ?? '';
      if (!t) {
        const ids = e.getAttribute('aria-labelledby');
        if (ids) t = ids.split(/\s+/).map((i) => document.getElementById(i)?.innerText ?? '').join(' ');
      }
      if (!t) {
        const box = e.closest('fieldset, [class*="field"], [class*="question"], [class*="form-group"], li, div');
        t = (box?.querySelector('legend, label, [class*="label"]') as HTMLElement | null)?.innerText ?? '';
      }
      return clean(t || e.getAttribute('placeholder') || (e as HTMLInputElement).name);
    };

    const fields: string[] = [];
    const buttons: string[] = [];
    let i = start;
    const sel =
      'input:not([type="hidden"]), select, textarea, [contenteditable="true"], [role="combobox"], [role="checkbox"], [role="radio"], [role="option"], ' +
      'button, a[href], [role="button"], [role="link"]';
    for (const el of Array.from(document.querySelectorAll(sel)) as HTMLElement[]) {
      if (i - start >= 90 || !shown(el)) continue;
      const tag = el.tagName.toLowerCase();
      const type = ((el as HTMLInputElement).type || '').toLowerCase();
      const role = el.getAttribute('role') ?? '';
      const req = (el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true' ? ' required' : '';
      let line = '';
      if (tag === 'select') {
        const s = el as HTMLSelectElement;
        const opts = Array.from(s.options).map((o) => clean(o.text, 40)).filter(Boolean);
        line = `select "${labelOf(el)}"${req} = "${clean(s.selectedOptions[0]?.text, 40)}" options: ${opts.slice(0, 20).join(' | ')}${opts.length > 20 ? ' | …' : ''}`;
      } else if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
        line = `${type} "${labelOf(el)}"${req}${(el as HTMLInputElement).checked ? ' [checked]' : ''}`;
      } else if (tag === 'input' && type === 'file') {
        line = `file upload "${labelOf(el)}"${req}${(el as HTMLInputElement).files?.length ? ' [file attached]' : ''}`;
      } else if (tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(type)) {
        line = `button "${clean((el as HTMLInputElement).value || el.getAttribute('aria-label'))}"`;
      } else if (tag === 'input' || tag === 'textarea' || el.isContentEditable || role === 'combobox') {
        const v = type === 'password' ? ((el as HTMLInputElement).value ? '[filled]' : '') : clean((el as HTMLInputElement).value ?? el.innerText, 60);
        const listbox = role === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox' || !!el.getAttribute('aria-autocomplete');
        line = `${type === 'password' ? 'password' : tag === 'textarea' ? 'textarea' : listbox ? 'dropdown/search (options appear when opened — use "select" with the option text)' : `text(${type || 'text'})`} "${labelOf(el)}"${req}${v ? ` = "${v}"` : ' (empty)'}`;
      } else if (role === 'checkbox' || role === 'radio') {
        line = `${role} "${clean(el.innerText || el.getAttribute('aria-label'))}"${el.getAttribute('aria-checked') === 'true' ? ' [checked]' : ''}`;
      } else if (role === 'option') {
        line = `option "${clean(el.innerText)}"`;
      } else {
        const text = clean(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title'));
        if (!text) continue;
        if (el.getAttribute('aria-haspopup') === 'listbox') {
          line = `dropdown (options appear when opened — use "select" with the option text) "${labelOf(el) || text}" = "${text}"`;
          el.setAttribute(MARK, String(i));
          el.setAttribute(`${MARK}-l`, (labelOf(el) || text).slice(0, 60));
          fields.push(`[${i}] ${line}`);
          i++;
          continue;
        }
        const href = el.getAttribute('href');
        const away = href && /^https?:/.test(href) && new URL(href).host !== location.host ? ` → ${new URL(href).host}` : '';
        line = `${tag === 'a' ? 'link' : 'button'} "${text}"${away}`;
      }
      el.setAttribute(MARK, String(i));
      el.setAttribute(`${MARK}-l`, (line.match(/"([^"]*)"/)?.[1] ?? '').slice(0, 60));
      (line.startsWith('button') || line.startsWith('link') ? buttons : fields).push(`[${i}] ${line}`);
      i++;
    }
    const errors = Array.from(document.querySelectorAll('[role="alert"], [class*="error" i], [aria-invalid="true"] + *'))
      .filter(shown)
      .map((e) => clean((e as HTMLElement).innerText, 120))
      .filter(Boolean)
      .slice(0, 5);
    const heading = clean((document.querySelector('h1, h2, h3') as HTMLElement | null)?.innerText, 100);
    const head = [
      `URL: ${location.href.split('?')[0]}`,
      `TITLE: ${clean(document.title)} | ${heading}`,
      errors.length ? `ERRORS: ${errors.join(' / ')}` : '',
      `TEXT: ${clean(document.body?.innerText, 500)}`,
    ]
      .filter(Boolean)
      .join('\n');
    return { head, fields, buttons, next: i };
  }
}

/** The element numbered `i` in the last snapshot, in whichever frame it is. */
async function marked(site: Page, i: number) {
  for (const frame of site.frames()) {
    const el = frame.locator(`[${MARK}="${i}"]`).first();
    if (await el.count().catch(() => 0)) return el;
  }
  return null;
}

const VERIFY = /verification code|enter (the|your) code|one[- ]time (pass(word|code)|code)|verify your (e-?mail|account)|check your (e-?mail|inbox)|activate your account/i;
const NEXT = /^\s*(next|continue|proceed|save (and|&) continue|next step|review|go on|save)\b/i;
const FINAL = /^\s*(submit|send|finish|complete)( my| your| the)?( application)?\s*$|submit application|send application/i;

export async function pageAgent(
  site: Page,
  ctx: BrowserContext,
  name: string,
  qctx: QuestionContext,
  dryRun: boolean,
  reason: string,
): Promise<ApplyResult | null> {
  if (!aiEnabled() || !qctx.facts) return null;
  const since = new Date();
  const startUrl = site.url();
  const history: string[] = [`(the built-in filler stopped: ${reason})`];
  let filledAny = false;
  let filledPage = false;
  let waits = 0;
  let same = 0;
  let last = '';
  let verified = 0;

  const done = (r: ApplyResult): ApplyResult => r;

  for (let step = 0; step < 14; step++) {
    if (await hasBlockingCaptcha(site)) return done({ status: 'needs_attention', note: `${name} has a captcha — apply yourself (takes a minute)`, applyUrl: site.url() });
    if (await site.getByText(SUCCESS).first().isVisible().catch(() => false)) {
      return done({ status: 'applied', note: `submitted on ${name} (AI agent)`, applyUrl: startUrl });
    }
    if (verified < 2 && (await site.getByText(VERIFY).first().isVisible().catch(() => false))) {
      verified++;
      const how = await confirmByEmail(site, name, since);
      if (how === 'link') await site.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      if (how) {
        history.push(`(verified the email ${how === 'link' ? 'via link' : 'with the emailed code'})`);
        continue;
      }
    }

    // Single-page apps keep loading after the first paint (Workday, Microsoft, iCIMS…)
    await site.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    let page = await snapshot(site).catch(() => '');
    for (let w = 0; w < 2 && /FIELDS:\n\(none\)/.test(page) && (page.match(/^\[\d+\] (button|link)/gm) ?? []).length < 6; w++) {
      await site.waitForTimeout(5000); // still loading — look again before asking the AI
      page = await snapshot(site).catch(() => '');
    }
    if (!page) break;
    same = page === last ? same + 1 : 0;
    last = page;
    if (same >= 2) break; // nothing is changing

    const plan = await aiNextActions(qctx.facts, page, { dryRun, history });
    if (!plan) break;
    if (plan.status === 'submitted') {
      if (dryRun) return done({ status: 'dry_run', note: `${name}: form filled by the AI agent (dry run — not sent)`, applyUrl: site.url() });
      if (await site.getByText(SUCCESS).first().isVisible().catch(() => false)) return done({ status: 'applied', note: `submitted on ${name} (AI agent)`, applyUrl: startUrl });
      history.push('(you said submitted, but no confirmation is visible — check the page again)');
      continue;
    }
    if (plan.status === 'working' && !plan.actions.length && waits++ < 2) {
      await site.waitForTimeout(6000); // the AI thinks the page is still loading
      continue;
    }
    if (plan.status === 'stuck' || !plan.actions.length) {
      return done({ status: 'needs_attention', note: `${name}: ${plan.why || 'the AI agent could not continue'}`, applyUrl: site.url() });
    }

    for (const a of plan.actions) {
      const el = await marked(site, a.i);
      if (!el) continue;
      const desc = (await el.getAttribute(`${MARK}-l`).catch(() => '')) || `#${a.i}`;
      // Dry run: after filling a page, only buttons that clearly go to the next step are pressed
      if (a.do === 'click' && dryRun && (FINAL.test(desc) || (filledPage && !NEXT.test(desc)))) {
        return done({ status: 'dry_run', note: `${name}: form filled by the AI agent (dry run — not sent)`, applyUrl: site.url() });
      }
      const ok = await act(site, ctx, a, el, qctx, desc);
      if (ok === 'popup') {
        const tab = ctx.pages().at(-1);
        if (tab && tab !== site) site = tab;
      }
      if (a.do === 'click') {
        if (!filledAny) trailClick(desc);
        filledPage = false;
        history.push(`clicked "${desc}"`);
        await site.waitForLoadState('domcontentloaded').catch(() => {});
        await pause(1500, 2500);
        break; // the page probably changed — look again
      }
      filledAny = true;
      filledPage = true;
      history.push(`${a.do} "${desc}"${a.do === 'fill' && !/PASSWORD/.test(a.value) ? ` = ${a.value.slice(0, 40)}` : a.do === 'select' ? ` = ${a.option}` : ''}${ok ? '' : ' (failed)'}`);
      if (a.do === 'fill' || a.do === 'select') qctx.aiLog?.push({ q: `${name}: ${desc}`, a: a.do === 'fill' ? (/PASSWORD/.test(a.value) ? '••••' : a.value) : a.option });
    }
  }
  return done({ status: 'needs_attention', note: `${name}: the AI agent couldn't finish this form — apply yourself`, applyUrl: site.url() });
}

async function act(
  site: Page,
  ctx: BrowserContext,
  a: PageAction,
  el: ReturnType<Page['locator']>,
  qctx: QuestionContext,
  desc: string,
): Promise<boolean | 'popup'> {
  try {
    switch (a.do) {
      case 'fill': {
        const value = String(a.value ?? '').replace(/\{\{PASSWORD\}\}/g, portalPassword() ?? '');
        if (!value) return false;
        const role = await el.getAttribute('role');
        await el.fill(value);
        if (role === 'combobox' || (await el.getAttribute('aria-autocomplete'))) {
          await pause(800, 1200);
          const opt = site.locator('[role="option"]:visible').filter({ hasText: value.slice(0, 30) }).first();
          if (await opt.isVisible().catch(() => false)) await opt.click();
          else await el.press('Enter').catch(() => {});
        }
        return true;
      }
      case 'select': {
        const tag = await el.evaluate((n) => n.tagName.toLowerCase());
        if (tag === 'select') {
          await el.selectOption({ label: a.option }).catch(() => el.selectOption(a.option));
        } else {
          // Custom dropdowns: open it, type to filter if it takes typing, then pick the option
          await el.click();
          await pause(500, 900);
          const typable = await el.evaluate((n) => n.tagName === 'INPUT' || (n as HTMLElement).isContentEditable).catch(() => false);
          if (typable) await el.fill(a.option).catch(() => {});
          else await site.keyboard.type(a.option.slice(0, 12), { delay: 60 }).catch(() => {});
          await pause(800, 1400);
          const want = a.option.trim().toLowerCase();
          const opts = site.locator('[role="option"]:visible, [role="menuitem"]:visible, [role="listbox"] li:visible, ul[class*="option" i] li:visible');
          let picked = false;
          for (const o of await opts.all()) {
            const t = ((await o.innerText().catch(() => '')) || '').trim().toLowerCase();
            if (t === want || (t.startsWith(want) && t.length - want.length < 25)) {
              await o.click().catch(() => {});
              picked = true;
              break;
            }
          }
          if (!picked) {
            const loose = opts.filter({ hasText: a.option }).first();
            if (await loose.isVisible().catch(() => false)) await loose.click();
            else await site.keyboard.press('Enter');
          }
        }
        return true;
      }
      case 'check':
        await el.check({ force: true }).catch(() => el.click({ force: true }));
        return true;
      case 'upload': {
        const file = a.file === 'cover' ? await coverLetterPdf(site, qctx) : env.resumePath;
        if (!file) return false;
        await el.setInputFiles(file);
        await pause(1500, 2500);
        return true;
      }
      case 'click': {
        const pages = ctx.pages().length;
        await el.click({ timeout: 8000 }).catch(() => el.click({ force: true }));
        await pause(800, 1200);
        return ctx.pages().length > pages ? 'popup' : true;
      }
    }
  } catch {
    return false;
  }
}

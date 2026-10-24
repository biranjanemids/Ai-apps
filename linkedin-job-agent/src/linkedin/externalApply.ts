import type { BrowserContext, Locator, Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, env } from '../config.js';
import { answerQuestion, identityAnswer, type Applicant, type FieldKind, type QuestionContext } from '../answers.js';
import { pause } from './browser.js';
import { workdayApply } from './workday.js';
import { accountPortalApply } from './accountPortal.js';
import { applyHref, findApplyButton, passInterstitials } from './jobs.js';
import type { ApplyResult } from './easyApply.js';

/** Portals that need an account first. The agent creates one with your job-portal password. */
const ACCOUNT_PORTALS: [RegExp, string][] = [
  [/myworkdayjobs\.com|workday\.com/, 'Workday'],
  [/taleo\.net/, 'Taleo'],
  [/icims\.com/, 'iCIMS'],
  [/successfactors|sapsf\./, 'SuccessFactors'],
  [/oraclecloud\.com/, 'Oracle'],
  [/brassring\.com/, 'BrassRing'],
  [/naukri\.com/, 'Naukri'],
  [/darwinbox\./, 'Darwinbox'],
  [/indeed\.com/, 'Indeed'],
  [/avature\.net/, 'Avature'],
];

/** Job boards where you sign in with your own existing account (and OTP) — left for you. */
const PERSONAL_LOGIN = /^(Naukri|Indeed)$/;

export function detectPortal(url: string): { kind: 'account' | 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | 'form'; name: string } {
  const host = (() => {
    try {
      return new URL(url).hostname + new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  for (const [re, name] of ACCOUNT_PORTALS) if (re.test(host)) return { kind: 'account', name };
  if (/greenhouse\.io/.test(host)) return { kind: 'greenhouse', name: 'Greenhouse' };
  if (/lever\.co/.test(host)) return { kind: 'lever', name: 'Lever' };
  if (/ashbyhq\.com/.test(host)) return { kind: 'ashby', name: 'Ashby' };
  if (/smartrecruiters\.com/.test(host)) return { kind: 'smartrecruiters', name: 'SmartRecruiters' };
  return { kind: 'form', name: 'company site' };
}

const SUCCESS = /thank you for (applying|your (application|interest))|application (has been |was )?(received|submitted|sent)|we('ve| have) received your application|successfully (applied|submitted)|application complete/i;

/**
 * Applies on the company's own careers site (the job's "Apply" button). Fills standard
 * application forms truthfully; anything that needs an account, a captcha or an answer the
 * agent doesn't have is left for you with a direct link.
 */
export async function externalApply(
  page: Page,
  ctx: BrowserContext,
  me: Applicant,
  qctx: QuestionContext,
  dryRun: boolean,
  directUrl?: string,
): Promise<ApplyResult> {
  const btn = await findApplyButton(page);
  let site: Page = page;
  if (btn) {
    directUrl = directUrl ?? (await applyHref(btn));
    const popup = ctx.waitForEvent('page', { timeout: 20000 }).catch(() => null);
    await btn.click().catch(() => {});
    // LinkedIn sometimes asks before leaving ("Continue to company site" / share profile)
    await passInterstitials(page);
    site = (await popup) ?? page;
    await site.waitForURL((u) => !/linkedin\.com/.test(u.hostname), { timeout: 20000 }).catch(() => {});
  }
  if (/linkedin\.com/.test(site.url()) && directUrl) {
    await site.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }
  await site.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  const applyUrl = site.url();
  const close = async () => {
    if (site !== page) await site.close().catch(() => {});
  };

  if (/linkedin\.com/.test(new URL(applyUrl).hostname)) {
    await close();
    return { status: 'failed', note: `Apply button didn't open the company site (stayed on ${site.url().split('?')[0]})` };
  }
  const portal = detectPortal(applyUrl);
  if (portal.name === 'Workday') {
    try {
      return await workdayApply(site, me, qctx, dryRun);
    } finally {
      await close();
    }
  }
  if (portal.kind === 'account' && PERSONAL_LOGIN.test(portal.name)) {
    await close();
    return { status: 'needs_attention', note: `${portal.name} needs your own ${portal.name} login — apply yourself`, applyUrl };
  }
  if (portal.kind === 'account') {
    try {
      if (await siteDown(site)) return unavailable(portal.name, site);
      return await accountPortalApply(site, portal.name, me, qctx, dryRun);
    } finally {
      await close();
    }
  }

  try {
    await openForm(site, portal.kind);
    if (await siteDown(site)) return unavailable(portal.name, site);
    // Some company sites ask you to sign in or register before the form
    if (await visible(site.locator('input[type="password"]').first())) {
      return await accountPortalApply(site, portal.name, me, qctx, dryRun);
    }
    const form = await findForm(site);
    if (!form) return { status: 'needs_attention', note: `couldn't find an application form on the ${portal.name}`, applyUrl };
    return await fillAndSubmit(site, form, portal.name, me, qctx, dryRun, applyUrl);
  } finally {
    await close();
  }
}

const visible = (l: Locator) => l.isVisible().catch(() => false);

/** Career sites show this during maintenance or outages — worth trying again later. */
export async function siteDown(site: Page): Promise<boolean> {
  return site
    .getByText(/currently unavailable|(scheduled|planned|under) maintenance|service (is )?(temporarily )?unavailable|site is down|try again later/i)
    .first()
    .isVisible()
    .catch(() => false);
}

export const unavailable = (name: string, site: Page): ApplyResult => ({
  status: 'failed',
  note: `${name} site temporarily unavailable (maintenance) — will retry on a later run`,
  applyUrl: site.url(),
});

const pageSignature = (site: Page) =>
  site.evaluate(() => `${location.href}|${(document.querySelector('h1, h2, h3, [data-automation-id="progressBarActiveStep"]') as HTMLElement | null)?.innerText ?? ''}`).catch(() => '');

const visibleErrors = async (site: Page) =>
  (await site.locator('[role="alert"]:visible, .error:visible, .field-error:visible, [class*="error-message"]:visible').allInnerTexts().catch(() => []))
    .map((t) => t.trim())
    .filter(Boolean);

/**
 * Fills the application step by step (Next / Continue) and submits at the end. Used for
 * company forms and, after signing in, for account portals like iCIMS, Taleo or SuccessFactors.
 */
export async function fillAndSubmit(
  site: Page,
  form: Locator,
  name: string,
  me: Applicant,
  qctx: QuestionContext,
  dryRun: boolean,
  applyUrl: string,
): Promise<ApplyResult> {
  const submitBtn = () =>
    form
      .locator('button[type="submit"], input[type="submit"]')
      .or(form.locator('button, a[role="button"]').filter({ hasText: /^\s*(submit|apply|send)( (my |your )?application| now)?\s*$/i }))
      .last();
  const nextBtn = () =>
    form.locator('button, a, input[type="button"]').filter({ hasText: /^\s*(next|continue|save (and|&) continue|proceed|next step)\s*(›|>|→)?\s*$/i }).first();

  for (let pageNo = 0; pageNo < 10; pageNo++) {
    const unanswered = await fillForm(site, form, me, qctx);
    if (unanswered.length) {
      return { status: 'needs_attention', note: `${name}: couldn't answer ${unanswered.slice(0, 3).join(' | ')}`, applyUrl: site.url() };
    }
    if (await hasBlockingCaptcha(site)) {
      return { status: 'needs_attention', note: `${name} has a captcha — apply yourself (takes a minute)`, applyUrl: site.url() };
    }
    const before = await pageSignature(site);

    // More steps to go: Next / Continue (multi-step portals often make these type="submit" too)
    const next = nextBtn();
    if (await visible(next)) {
      await next.click().catch(() => {});
      await site.waitForLoadState('domcontentloaded').catch(() => {});
      await pause(1500, 2500);
      const errors = await visibleErrors(site);
      if (errors.length && (await pageSignature(site)) === before && pageNo > 0) {
        return { status: 'needs_attention', note: `${name}: ${errors.join(' ').slice(0, 140)}`, applyUrl: site.url() };
      }
      continue;
    }

    const submit = submitBtn();
    if (!(await visible(submit))) {
      return { status: 'needs_attention', note: `${name}: no Submit button found`, applyUrl: site.url() };
    }
    if (dryRun) return { status: 'dry_run', note: `${name}: form filled (dry run — not sent)`, applyUrl: site.url() };
    await submit.click();
    const done = await Promise.race([
      site.getByText(SUCCESS).first().waitFor({ timeout: 25000 }).then(() => true),
      site.waitForURL(/confirm|thank|success|submitted/i, { timeout: 25000 }).then(() => true),
    ]).catch(() => false);
    if (done) return { status: 'applied', note: `submitted on ${name}`, applyUrl };
    const errors = await visibleErrors(site);
    if (errors.length) return { status: 'needs_attention', note: `${name} rejected the form: ${errors.join(' ').slice(0, 120)}`, applyUrl: site.url() };
    // "Submit" sometimes just saves a step (e.g. before a review page) — keep going if the page moved on
    const moved = (await pageSignature(site)) !== before;
    const fields = await site.locator('input:visible, select:visible, textarea:visible, button[type="submit"]:visible').count().catch(() => 0);
    if (!moved || !fields) break;
  }
  return { status: 'failed', note: `${name}: clicked Submit but saw no confirmation`, applyUrl: site.url() };
}

/** Get from the job description page to the actual form. */
export async function openForm(site: Page, kind: string) {
  const url = site.url();
  if (kind === 'lever' && !/\/apply/.test(url)) {
    await site.goto(url.replace(/[?#].*$/, '').replace(/\/$/, '') + '/apply', { waitUntil: 'domcontentloaded' });
  } else if (kind === 'ashby' && !/\/application/.test(url)) {
    await site.goto(url.replace(/[?#].*$/, '').replace(/\/$/, '') + '/application', { waitUntil: 'domcontentloaded' });
  }
  if (await findForm(site)) return;
  // Many career pages show the description first with an "Apply" button
  const opener = site
    .locator('a, button')
    .filter({ hasText: /^\s*(apply( now| online| for this (job|position|role|opportunity))?( online)?|start (your |my )?application|i'?m interested)\s*$/i })
    .first();
  if (await opener.isVisible().catch(() => false)) {
    await opener.click().catch(() => {});
    await site.waitForLoadState('domcontentloaded').catch(() => {});
    await pause(1500, 2500);
  }
}

export async function findForm(site: Page): Promise<Locator | null> {
  await site.waitForSelector('input[type="email"], input[type="file"], input[name*="email" i]', { timeout: 10000 }).catch(() => {});
  const form = site.locator('form').filter({ has: site.locator('input[type="email"], input[name*="email" i], input[type="file"]') }).first();
  if (await form.count()) return form;
  // Some sites don't use a <form> element
  return (await site.locator('input[type="email"], input[name*="email" i]').count()) ? site.locator('body') : null;
}

/** Label text for a form control, trying the usual ways sites attach labels. */
const labelOf = (el: Locator) =>
  el.evaluate((node) => {
    const e = node as HTMLInputElement;
    let t = '';
    if (e.id) t = (document.querySelector(`label[for="${CSS.escape(e.id)}"]`) as HTMLElement | null)?.innerText ?? '';
    if (!t) t = (e.closest('label') as HTMLElement | null)?.innerText ?? '';
    if (!t) t = e.getAttribute('aria-label') ?? '';
    if (!t) {
      const ids = e.getAttribute('aria-labelledby');
      if (ids) t = ids.split(/\s+/).map((i) => document.getElementById(i)?.innerText ?? '').join(' ');
    }
    if (!t) {
      const box = e.closest('.field, .application-question, .form-group, fieldset, li, [class*="field"], [class*="question"]');
      t = (box?.querySelector('label, legend, [class*="label"]') as HTMLElement | null)?.innerText ?? '';
    }
    if (!t) t = e.getAttribute('placeholder') || e.name || '';
    return t.replace(/\s+/g, ' ').trim();
  });

const isRequired = (el: Locator, label: string) =>
  el.evaluate((n) => (n as HTMLInputElement).required || n.getAttribute('aria-required') === 'true').then((r) => r || /\*/.test(label));

/** Fills a company application form; returns required questions it couldn't answer. */
export async function fillForm(site: Page, form: Locator, me: Applicant, qctx: QuestionContext): Promise<string[]> {
  const unanswered: string[] = [];

  // Resume / CV upload (file inputs are often hidden behind a styled button)
  for (const file of await form.locator('input[type="file"]').all()) {
    const label = await labelOf(file);
    const meta = `${label} ${(await file.getAttribute('name')) ?? ''} ${(await file.getAttribute('id')) ?? ''}`;
    if (/cover/i.test(meta)) {
      const pdf = (await isRequired(file, label)) ? await coverLetterPdf(site, qctx) : null;
      if (pdf) await file.setInputFiles(pdf).catch(() => unanswered.push('cover letter upload'));
      else if (await isRequired(file, label)) unanswered.push('cover letter upload');
      continue;
    }
    if (!/resume|cv|attach/i.test(meta) && (await form.locator('input[type="file"]').count()) > 1) continue;
    if (env.resumePath) await file.setInputFiles(env.resumePath).catch(() => unanswered.push('resume upload'));
    else unanswered.push('resume (upload one on the dashboard)');
  }
  await pause(500, 1000);

  // Dropdowns built as comboboxes (Greenhouse/Ashby react-select, location autocompletes)
  for (const box of await form.locator('input[role="combobox"]').all()) {
    if (!(await box.isVisible().catch(() => false)) || (await box.inputValue().catch(() => 'x'))) continue;
    const wrap = box.locator('xpath=ancestor::*[contains(@class,"select") or contains(@class,"field") or contains(@class,"question")][1]');
    if ((await wrap.locator('[class*="single-value"], [class*="singleValue"]').count()) > 0) continue; // already chosen
    const label = await labelOf(box);
    await box.click().catch(() => {});
    const optsLoc = site.locator('[role="option"]:visible');
    await optsLoc.first().waitFor({ timeout: 3000 }).catch(() => {});
    const options = (await optsLoc.allInnerTexts().catch(() => [])).map((o) => o.trim()).filter(Boolean);
    const ident = identityAnswer(label, 'text', me);
    const ans = options.length
      ? (ident && options.find((o) => o.toLowerCase().startsWith(ident.toLowerCase()))) || (await answerQuestion(label, 'select', options, qctx))
      : ident ?? (await answerQuestion(label, 'text', [], qctx));
    if (!ans) {
      await box.press('Escape').catch(() => {});
      if (await isRequired(box, label)) unanswered.push(label);
      continue;
    }
    await box.fill(ans).catch(() => {});
    await pause(800, 1400);
    const match = site.locator('[role="option"]:visible').filter({ hasText: ans.slice(0, 40) }).first();
    if (await match.isVisible().catch(() => false)) await match.click().catch(() => {});
    else await box.press('Enter').catch(() => {});
  }

  // Text inputs and textareas
  const texts = form.locator('input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea');
  for (const el of await texts.all()) {
    if (!(await el.isVisible().catch(() => false)) || (await el.inputValue().catch(() => 'x'))) continue;
    if ((await el.getAttribute('role')) === 'combobox') continue; // handled above
    const label = await labelOf(el);
    const type = ((await el.getAttribute('type')) ?? 'text').toLowerCase();
    const required = await isRequired(el, label);
    let ans = identityAnswer(label, type, me);
    if (ans === undefined) {
      const tag = await el.evaluate((n) => n.tagName.toLowerCase());
      const kind: FieldKind = type === 'number' ? 'number' : tag === 'textarea' ? 'textarea' : 'text';
      if (/cover (letter|note)/i.test(label)) ans = qctx.coverNote ? await qctx.coverNote() : null;
      else if (/additional information|anything else/i.test(label)) ans = null;
      else ans = await answerQuestion(label, kind, [], qctx);
      if (ans && /cover (letter|note)/i.test(label)) qctx.aiLog?.push({ q: 'Cover note', a: ans });
    }
    if (ans) {
      await el.fill(ans);
      if ((await el.getAttribute('role')) === 'combobox' || (await el.getAttribute('aria-autocomplete'))) {
        await pause(800, 1200);
        await el.press('ArrowDown').catch(() => {});
        await el.press('Enter').catch(() => {});
      }
    } else if (required) {
      unanswered.push(label || '(unlabelled field)');
    }
  }

  // Dropdowns
  for (const sel of await form.locator('select').all()) {
    if (!(await sel.isVisible().catch(() => false))) continue;
    const chosen = await sel.evaluate((s: HTMLSelectElement) => s.selectedIndex > 0 && !!s.value);
    if (chosen) continue;
    const label = await labelOf(sel);
    const options = await sel.evaluate((s: HTMLSelectElement) => Array.from(s.options).map((o) => o.text.trim()));
    const ans = await answerQuestion(label, 'select', options.slice(1), qctx);
    if (ans) await sel.selectOption({ label: ans }).catch(() => unanswered.push(label));
    else if (await isRequired(sel, label)) unanswered.push(label);
  }

  // Radio groups
  const groups = new Set(await form.locator('input[type="radio"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).name)));
  for (const name of groups) {
    if (!name) continue;
    const radios = form.locator(`input[type="radio"][name="${name}"]`);
    if ((await form.locator(`input[type="radio"][name="${name}"]:checked`).count()) > 0) continue;
    const first = radios.first();
    const question = await first.evaluate((n) => {
      const box = n.closest('fieldset, .field, .application-question, [class*="question"], [role="radiogroup"]');
      return ((box?.querySelector('legend, label, [class*="label"]') as HTMLElement | null)?.innerText ?? '').trim();
    });
    const options = await radios.evaluateAll((els) =>
      els.map((e) => ((e.id && (document.querySelector(`label[for="${CSS.escape(e.id)}"]`) as HTMLElement | null)?.innerText) || (e.closest('label') as HTMLElement | null)?.innerText || (e as HTMLInputElement).value || '').trim()),
    );
    const ans = await answerQuestion(question, 'radio', options, qctx);
    const idx = ans ? options.indexOf(ans) : -1;
    if (idx >= 0) await radios.nth(idx).check({ force: true }).catch(() => unanswered.push(question));
    else if ((await first.evaluate((n) => (n as HTMLInputElement).required)) || /\*/.test(question)) unanswered.push(question);
  }

  // Consent checkboxes ("I agree to the privacy policy")
  for (const box of await form.locator('input[type="checkbox"]').all()) {
    if (await box.isChecked().catch(() => true)) continue;
    const label = await labelOf(box);
    if (/agree|consent|acknowledge|privacy|terms|confirm|certify/i.test(label)) await box.check({ force: true }).catch(() => {});
    else if (await isRequired(box, label)) unanswered.push(label);
  }

  return [...new Set(unanswered.filter(Boolean))];
}

/** A visible "I'm not a robot" style captcha that must be solved by a person. */
export async function hasBlockingCaptcha(site: Page): Promise<boolean> {
  const frames = site.locator('iframe[src*="recaptcha/api2/anchor"], iframe[src*="hcaptcha.com"][src*="checkbox"], iframe[src*="challenges.cloudflare.com"]');
  for (const f of await frames.all()) {
    const box = await f.boundingBox().catch(() => null);
    if (box && box.width > 50 && box.height > 30) return true;
  }
  return false;
}

/** Turns the AI cover note into a PDF for forms that want a cover-letter file. */
async function coverLetterPdf(site: Page, qctx: QuestionContext): Promise<string | null> {
  const note = qctx.coverNote ? await qctx.coverNote() : null;
  if (!note) return null;
  qctx.aiLog?.push({ q: 'Cover letter (PDF)', a: note });
  const dir = path.join(DATA_DIR, 'cover-letters');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cover-letter-${Date.now()}.pdf`);
  const tmp = await site.context().newPage();
  try {
    const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    await tmp.setContent(
      `<html><body style="font:12pt/1.5 Georgia,serif;margin:2cm">${note.split(/\n+/).map((p) => `<p>${esc(p)}</p>`).join('')}</body></html>`,
    );
    await tmp.pdf({ path: file, format: 'A4' });
    return file;
  } catch {
    return null;
  } finally {
    await tmp.close().catch(() => {});
  }
}

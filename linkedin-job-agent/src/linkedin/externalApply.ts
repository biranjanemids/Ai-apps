import type { BrowserContext, Locator, Page, Request } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, env } from '../config.js';
import { answerQuestion, identityAnswer, type Applicant, type FieldKind, type QuestionContext } from '../answers.js';
import { pause } from './browser.js';
import { workdayApply } from './workday.js';
import { accountPortalApply } from './accountPortal.js';
import { applyHref, applyMethod, findApplyButton, passInterstitials, unwrapLinkedIn } from './jobs.js';
import { aiPickClick } from '../ai.js';
import { pageAgent } from './pageAgent.js';
import { navFor, saveTrail, startTrail, trailClick } from './siteMemory.js';
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

export const SUCCESS = /thank you for (applying|your (application|interest))|application (has been |was )?(received|submitted|sent)|we('ve| have) received your application|successfully (applied|submitted)|application complete/i;

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
  const jobId = page.url().match(/\/jobs\/view\/(\d+)/)?.[1];
  const btn = await findApplyButton(page);
  let site: Page = page;
  // Where the button tries to go, even if the new tab is blocked or the page load is cancelled
  const tried: string[] = [];
  const watch = (r: Request) => {
    try {
      if (r.isNavigationRequest() && !/linkedin\.com|licdn\.com/.test(new URL(r.url()).hostname)) tried.push(r.url());
    } catch {
      // not a URL we care about
    }
  };
  if (btn) {
    directUrl = directUrl ?? (await applyHref(btn));
    await page
      .evaluate(() => {
        const w = window as unknown as { __jaOpened?: string[]; open: typeof window.open };
        w.__jaOpened = [];
        const orig = window.open.bind(window);
        w.open = (url?: string | URL, ...rest: unknown[]) => {
          if (url) w.__jaOpened!.push(String(url));
          return orig(url as string, ...(rest as [string?, string?]));
        };
      })
      .catch(() => {});
    ctx.on('request', watch);
    const popup = ctx.waitForEvent('page', { timeout: 20000 }).catch(() => null);
    await btn.click().catch(() => {});
    // LinkedIn sometimes asks before leaving ("Continue to company site" / share profile)
    await passInterstitials(page);
    site = (await popup) ?? page;
    await site.waitForURL((u) => !/linkedin\.com/.test(u.hostname), { timeout: 20000 }).catch(() => {});
    ctx.off('request', watch);
    if (/linkedin\.com/.test(site.url())) {
      const opened = (await page.evaluate(() => (window as unknown as { __jaOpened?: string[] }).__jaOpened ?? []).catch(() => [])) as string[];
      const seen = [...tried, ...opened.map((u) => unwrapLinkedIn(new URL(u, 'https://www.linkedin.com').toString()) ?? '')].find((u) => /^https?:/.test(u) && !/linkedin\.com/.test(u));
      directUrl = directUrl && !/linkedin\.com/.test(directUrl) ? directUrl : seen ?? directUrl;
    }
  }
  // The button did nothing: ask LinkedIn's own data where this job is applied to
  if (/linkedin\.com/.test(site.url()) && (!directUrl || /linkedin\.com/.test(directUrl)) && jobId) {
    if (site !== page) await site.close().catch(() => {});
    site = page;
    directUrl = (await applyMethod(page, jobId))?.url ?? directUrl;
  }
  directUrl = unwrapLinkedIn(directUrl) ?? directUrl;
  if (/linkedin\.com/.test(site.url()) && directUrl) {
    await site.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }
  await site.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  const applyUrl = site.url();
  const opened = new Set<Page>([site]);
  const close = async () => {
    for (const p of opened) if (p !== page) await p.close().catch(() => {});
  };

  if (/linkedin\.com/.test(new URL(applyUrl).hostname)) {
    await close();
    return { status: 'failed', note: `Apply button didn't open the company site (stayed on ${site.url().split('?')[0]})` };
  }

  startTrail(applyUrl);
  try {
    const res = await route();
    if (res.status === 'applied' || res.status === 'dry_run') saveTrail();
    return res;
  } finally {
    await close();
  }

  async function route(): Promise<ApplyResult> {
    // Career pages often hand over to another site (jobs.company.com → Workday/iCIMS…), so
    // re-check where we are after every hop
    let aiClicks = 0;
    const navClicks: string[] = [];
    let replayed = false;
    for (let hop = 0; hop < 6; hop++) {
      await dismissCookies(site);
      const portal = detectPortal(site.url());
      if (await siteDown(site)) return unavailable(portal.name, site);
      if (portal.name === 'Workday') return await workdayApply(site, me, qctx, dryRun);
      if (portal.kind === 'account' && PERSONAL_LOGIN.test(portal.name)) {
        return { status: 'needs_attention', note: `${portal.name} needs your own ${portal.name} login (OTP to your phone) — apply yourself`, applyUrl: site.url() };
      }
      if (portal.kind === 'account') return await accountPortalApply(site, portal.name, me, qctx, dryRun);

      const host = new URL(site.url()).host;
      const next = await openForm(site, portal.kind, ctx);
      if (next !== site) {
        opened.add(next);
        site = next;
      }
      if (new URL(site.url()).host !== host) continue; // moved to another site — route again
      // Some company sites ask you to sign in or register before the form
      if (await visible(site.locator('input[type="password"]').first())) {
        return await accountPortalApply(site, portal.name, me, qctx, dryRun);
      }
      const form = await findForm(site, 6000);
      if (form) {
        return await fillAndSubmit(site, form, portal.name, me, qctx, dryRun, applyUrl);
      }
      // Been here before: repeat the clicks that reached the form last time
      if (!replayed) {
        replayed = true;
        const before = site.url();
        for (const text of navFor(applyUrl)) {
          const el = site.locator('a, button, [role="button"], input[type="submit"]').filter({ hasText: new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') }).first();
          if (!(await visible(el))) break;
          await el.click().catch(() => {});
          await site.waitForLoadState('domcontentloaded').catch(() => {});
          await pause(1500, 2500);
          navClicks.push(text);
          trailClick(text);
        }
        if (site.url() !== before || navClicks.length) continue;
      }
      // Unfamiliar page: let the AI pick the button that leads to the application
      if (aiClicks++ >= 3) break;
      const moved = await aiStep(site, ctx, navClicks);
      if (!moved) break;
      if (moved !== site) {
        opened.add(moved);
        site = moved;
      }
    }
    // Nothing built in fits this site: the AI page agent drives it step by step
    const learned = await pageAgent(site, ctx, new URL(site.url()).host, qctx, dryRun, 'no application form recognised');
    return learned ?? { status: 'needs_attention', note: `couldn't find an application form on ${new URL(site.url()).host}`, applyUrl: site.url() };
  }
}

/** Cookie banners cover buttons on many career sites. */
async function dismissCookies(site: Page) {
  const btn = site
    .locator('#onetrust-accept-btn-handler, #truste-consent-button, button[id*="cookie" i][id*="accept" i]')
    .or(
      site
        .locator('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [aria-label*="cookie" i], [role="dialog"]')
        .locator('button, a[role="button"]')
        .filter({ hasText: /^\s*(accept( all)?( cookies)?|allow( all)?( cookies)?|i agree|agree( and close)?|got it|ok(ay)?|i accept)\s*$/i }),
    )
    .first();
  if (await visible(btn)) {
    await btn.click().catch(() => {});
    await pause(500, 900);
  }
}

/** Asks the AI which link/button leads to the application; clicks it. Returns the page now showing. */
export async function aiStep(site: Page, ctx: BrowserContext = site.context(), clicked?: string[]): Promise<Page | null> {
  const items: Locator[] = [];
  const labels: string[] = [];
  for (const el of await site.locator('a, button, [role="button"], input[type="submit"], input[type="button"]').all()) {
    if (items.length >= 70) break;
    if (!(await visible(el))) continue;
    const text = (
      (await el.innerText().catch(() => '')) ||
      (await el.getAttribute('aria-label').catch(() => '')) ||
      (await el.getAttribute('value').catch(() => '')) ||
      ''
    ).replace(/\s+/g, ' ').trim();
    if (!text || text.length > 80) continue;
    const href = await el.getAttribute('href').catch(() => null);
    const where = href && /^https?:/.test(href) ? ` → ${new URL(href).host}` : '';
    items.push(el);
    labels.push(`${text}${where}`);
  }
  const heading = `${await site.title().catch(() => '')} — ${site.url().split('?')[0]}`;
  const i = await aiPickClick('open the application form for this job and apply', heading, labels);
  if (i === null) return null;
  const before = site.url();
  const popup = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  clicked?.push(labels[i].replace(/ → .*$/, ''));
  trailClick(labels[i].replace(/ → .*$/, ''));
  await items[i].click().catch(() => {});
  await site.waitForLoadState('domcontentloaded').catch(() => {});
  await pause(1500, 2500);
  const tab = await popup;
  if (tab) {
    await tab.waitForLoadState('domcontentloaded').catch(() => {});
    return tab;
  }
  return site.url() !== before || (await site.locator('input:visible').count()) > 0 ? site : null;
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
      // Odd widgets or unlabelled fields: the AI agent can see the whole page and finish it
      return (await pageAgent(site, site.context(), name, qctx, dryRun, `these required fields are still empty: ${unanswered.slice(0, 5).join(' | ')}`)) ?? {
        status: 'needs_attention',
        note: `${name}: couldn't answer ${unanswered.slice(0, 3).join(' | ')}`,
        applyUrl: site.url(),
      };
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
      return (await pageAgent(site, site.context(), name, qctx, dryRun, 'no Submit button found')) ??
        { status: 'needs_attention', note: `${name}: no Submit button found`, applyUrl: site.url() };
    }
    if (dryRun) return { status: 'dry_run', note: `${name}: form filled (dry run — not sent)`, applyUrl: site.url() };
    await submit.click();
    const done = await Promise.race([
      site.getByText(SUCCESS).first().waitFor({ timeout: 25000 }).then(() => true),
      site.waitForURL(/confirm|thank|success|submitted/i, { timeout: 25000 }).then(() => true),
    ]).catch(() => false);
    if (done) return { status: 'applied', note: `submitted on ${name}`, applyUrl };
    const errors = await visibleErrors(site);
    if (errors.length) {
      return (await pageAgent(site, site.context(), name, qctx, dryRun, `the site showed errors: ${errors.join(' ').slice(0, 200)}`)) ??
        { status: 'needs_attention', note: `${name} rejected the form: ${errors.join(' ').slice(0, 120)}`, applyUrl: site.url() };
    }
    // "Submit" sometimes just saves a step (e.g. before a review page) — keep going if the page moved on
    const moved = (await pageSignature(site)) !== before;
    const fields = await site.locator('input:visible, select:visible, textarea:visible, button[type="submit"]:visible').count().catch(() => 0);
    if (!moved || !fields) break;
  }
  return (await pageAgent(site, site.context(), name, qctx, dryRun, 'clicked Submit but saw no confirmation')) ??
    { status: 'failed', note: `${name}: clicked Submit but saw no confirmation`, applyUrl: site.url() };
}

/** Application systems career pages link out to — following the link beats hunting for buttons. */
const ATS_LINK = /myworkdayjobs\.com|icims\.com|taleo\.net|greenhouse\.io|lever\.co|smartrecruiters\.com|successfactors|sapsf\.|oraclecloud\.com|ashbyhq\.com|brassring\.com|avature\.net|darwinbox\.|jobvite\.com|bamboohr\.com|recruitee\.com|workable\.com|personio\.|zohorecruit|keka\.com|freshteam\.com|teamtailor\.com|eightfold\.ai|phenompeople|recruiterbox|applytojob\.com/i;

/** Get from the job description page to the actual form. Returns the page showing it (may be a new tab). */
export async function openForm(site: Page, kind: string, ctx?: BrowserContext): Promise<Page> {
  const url = site.url();
  if (kind === 'lever' && !/\/apply/.test(url)) {
    await site.goto(url.replace(/[?#].*$/, '').replace(/\/$/, '') + '/apply', { waitUntil: 'domcontentloaded' });
  } else if (kind === 'ashby' && !/\/application/.test(url)) {
    await site.goto(url.replace(/[?#].*$/, '').replace(/\/$/, '') + '/application', { waitUntil: 'domcontentloaded' });
  }
  if (await findForm(site)) return site;
  // A link straight into the company's application system
  const here = new URL(site.url()).host;
  for (const a of await site.locator('a[href]').all()) {
    const href = await a.getAttribute('href').catch(() => null);
    if (!href || !(await visible(a))) continue;
    let target: URL;
    try {
      target = new URL(href, site.url());
    } catch {
      continue;
    }
    if (target.host !== here && ATS_LINK.test(target.host) && /apply|job|career|requisition|posting/i.test(`${await a.innerText().catch(() => '')} ${target.pathname}`)) {
      await site.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await pause(1500, 2500);
      return site;
    }
  }
  // Many career pages show the description first with an "Apply" button
  const opener = site
    .locator('a, button, [role="button"], input[type="submit"]')
    .filter({ hasText: /^\s*(apply( now| online| here| today| for this (job|position|role|opportunity))?( online)?|start (your |my )?application|i'?m interested|submit (your )?(cv|resume|application))\s*(›|>|→)?\s*$/i })
    .first();
  if (await visible(opener)) {
    const popup = ctx ? ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null) : Promise.resolve(null);
    await opener.click().catch(() => {});
    await site.waitForLoadState('domcontentloaded').catch(() => {});
    await pause(1500, 2500);
    const tab = await popup;
    if (tab) {
      await tab.waitForLoadState('domcontentloaded').catch(() => {});
      return tab;
    }
  }
  return site;
}

export async function findForm(site: Page, waitMs = 10000): Promise<Locator | null> {
  await site.waitForSelector('input[type="email"], input[type="file"], input[name*="email" i]', { timeout: waitMs }).catch(() => {});
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
    // Helper inputs of custom widgets (hidden from screen readers) aren't questions
    if (await el.evaluate((n) => !!n.closest('[aria-hidden="true"]') || (n as HTMLInputElement).readOnly).catch(() => false)) continue;
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
export async function coverLetterPdf(site: Page, qctx: QuestionContext): Promise<string | null> {
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

import type { Locator, Page } from 'playwright';
import { portalPassword } from '../config.js';
import type { Applicant, QuestionContext } from '../answers.js';
import { pause } from './browser.js';
import type { ApplyResult } from './easyApply.js';
import { aiStep, fillAndSubmit, fillForm, hasBlockingCaptcha, openForm, siteDown, unavailable } from './externalApply.js';
import { confirmByEmail } from '../mail.js';
import { pageAgent } from './pageAgent.js';
import { mailAccess } from '../config.js';
import { readAccounts, saveAccount } from './workday.js';

/**
 * Career portals that want an account before the form: iCIMS, Taleo, SuccessFactors, Oracle,
 * BrassRing, Avature, Darwinbox and company sites with a sign-in page. Each looks different,
 * so this works from what's on screen: sign in (or register the first time) with your email and
 * job-portal password, then fill the application like any other form. Email verification
 * codes and captchas are left for you.
 */

const visible = (l: Locator) => l.isVisible().catch(() => false);
const BUTTON = 'button, input[type="submit"], input[type="button"], a[role="button"], a';
const CREATE_LINK = /^\s*(create (an |new )?(account|profile)|register( now)?|sign ?up|new (user|candidate)\??.*|join( now)?|i'?m new.*)\s*$/i;
const VERIFY = /verification code|enter (the|your) code|one[- ]time (pass(word|code)|code)|\botp\b|we('ve| have)? sent (you )?(an? )?(email|code|link)|check your (e-?mail|inbox)|verify your (e-?mail|account)|activate your account|confirm your e-?mail/i;

/** iCIMS (and a few others) render the whole flow inside an iframe — open it as the page. */
async function unwrapFrame(site: Page) {
  const frame = site.locator('iframe#icims_content_iframe, iframe[src*="in_iframe=1"], iframe[src*="icims.com"]').first();
  if (!(await frame.count())) return;
  const src = await frame.getAttribute('src').catch(() => null);
  if (!src) return;
  await site.goto(new URL(src, site.url()).toString(), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await pause(1500, 2500);
}

async function clickButton(site: Page, re: RegExp): Promise<boolean> {
  for (const b of await site.locator(BUTTON).all()) {
    if (!(await visible(b))) continue;
    const t = `${await b.innerText().catch(() => '')} ${(await b.getAttribute('value').catch(() => '')) ?? ''}`.replace(/\s+/g, ' ').trim();
    if (re.test(t)) {
      await b.click().catch(() => {});
      await site.waitForLoadState('domcontentloaded').catch(() => {});
      await pause(2000, 3000);
      return true;
    }
  }
  return false;
}

/** Email / user-name boxes on a sign-in or register page. */
async function fillLogin(site: Page, email: string) {
  for (const el of await site.locator('input[type="email"], input[type="text"], input:not([type])').all()) {
    if (!(await visible(el)) || (await el.inputValue().catch(() => 'x'))) continue;
    const meta = await el.evaluate((n) => {
      const e = n as HTMLInputElement;
      const lab = (e.id && (document.querySelector(`label[for="${CSS.escape(e.id)}"]`) as HTMLElement | null)?.innerText) || '';
      return `${e.type} ${e.name} ${e.id} ${e.placeholder} ${e.getAttribute('aria-label') ?? ''} ${e.autocomplete} ${lab}`.toLowerCase();
    });
    if (/e-?mail|user ?(name|id)|login|username/.test(meta)) await el.fill(email).catch(() => {});
  }
}

export async function accountPortalApply(site: Page, name: string, me: Applicant, qctx: QuestionContext, dryRun: boolean): Promise<ApplyResult> {
  const applyUrl = site.url();
  const host = new URL(applyUrl).hostname;
  const password = portalPassword();
  if (!me.email) return { status: 'needs_attention', note: `${name}: add your email under "My answers" first`, applyUrl };
  if (!password) {
    return { status: 'needs_attention', note: `${name} needs an account — set a job-portal password on the dashboard so the agent can create one`, applyUrl };
  }
  const short = host.replace(/^(www|careers?|jobs)[-.]/, '').split('.')[0];
  let signInTries = 0;
  let createTries = 0;
  let verifyTries = 0;
  let aiTries = 0;
  const since = new Date();
  /** Reads the verification email and finishes that step; false when it can't. */
  const verifyByEmail = async () => {
    if (!mailAccess() || verifyTries++ > 1) return false;
    const done = await confirmByEmail(site, short, since);
    if (done === 'link') await site.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    return Boolean(done);
  };
  /** Unfamiliar page: let the AI pick the button that moves things along. */
  const aiMove = async () => aiTries++ < 3 && (await aiStep(site)) === site;

  for (let step = 0; step < 10; step++) {
    await unwrapFrame(site);
    if (await siteDown(site)) return unavailable(name, site);
    if (await hasBlockingCaptcha(site)) return { status: 'needs_attention', note: `${name} has a captcha — apply yourself (takes a minute)`, applyUrl: site.url() };

    const passwords = site.locator('input[type="password"]:visible');
    const pwCount = await passwords.count();
    const known = readAccounts()[host];

    if (pwCount > 0) {
      // Sign-in page, and we have no account here yet → switch to "create account"
      if (pwCount === 1 && !known && createTries === 0 && (await clickButton(site, CREATE_LINK))) {
        createTries++;
        continue;
      }
      const creating = pwCount >= 2 || !known;
      if (creating ? createTries++ > 1 : signInTries++ > 1) {
        const err = (await site.locator('[role="alert"]:visible, [class*="error"]:visible').allInnerTexts().catch(() => [])).join(' ').trim();
        if (!err) {
          const ai = await pageAgent(site, site.context(), name, qctx, dryRun, creating ? 'account sign-up page not recognised' : 'sign-in page not recognised');
          if (ai) return ai;
        }
        return {
          status: 'needs_attention',
          note: `${name}: ${creating ? 'couldn\'t create an account' : 'sign-in failed'} on ${short}${err ? `: ${err.slice(0, 100)}` : ''} — if you already have an account there, set the same job-portal password or reset it`,
          applyUrl: site.url(),
        };
      }
      await fillLogin(site, me.email);
      for (const pw of await passwords.all()) await pw.fill(password).catch(() => {});
      if (creating) {
        // Registration pages also ask for name, phone, country and consent
        const missing = await fillForm(site, site.locator('body'), me, qctx);
        if (missing.length) return { status: 'needs_attention', note: `${name} account form: couldn't answer ${missing.slice(0, 3).join(' | ')}`, applyUrl: site.url() };
        if (!(await clickButton(site, /^\s*(create( (an |my )?account)?|register|sign ?up|submit|next|continue|save)\s*$/i))) await aiMove();
        saveAccount(host, { email: me.email, created: new Date().toISOString() });
      } else {
        if (!(await clickButton(site, /^\s*(sign ?in|log ?in|login|next|continue|submit)\s*$/i))) await aiMove();
      }
      if (await site.getByText(VERIFY).first().isVisible().catch(() => false)) {
        if (await verifyByEmail()) continue;
        return { status: 'needs_attention', note: `${name} (${short}) wants to verify ${me.email} — tap the link in that email (or add Email access on the dashboard so the agent does it), then the next run carries on`, applyUrl: site.url() };
      }
      continue;
    }

    if (await site.getByText(VERIFY).first().isVisible().catch(() => false)) {
      if (await verifyByEmail()) continue;
      return { status: 'needs_attention', note: `${name} (${short}) sent a code to ${me.email} — finish this application yourself`, applyUrl: site.url() };
    }

    // Email-first sign-in (iCIMS, Oracle): just an email box, maybe a privacy checkbox, and Next
    const inputs = await site.locator('input[type="text"]:visible, input[type="email"]:visible, input[type="tel"]:visible, input:not([type]):visible, select:visible, textarea:visible, input[type="file"]').count();
    const emailBox = site.locator('input[type="email"]:visible, input[name*="email" i]:visible, input[id*="email" i]:visible').first();
    if (inputs <= 2 && (await visible(emailBox))) {
      if (signInTries++ > 2) break;
      await fillLogin(site, me.email);
      for (const box of await site.locator('input[type="checkbox"]').all()) {
        if (await box.isChecked().catch(() => true)) continue;
        const near = await box.evaluate((n) => ((n.closest('label') as HTMLElement | null)?.innerText ?? n.parentElement?.innerText ?? '')).catch(() => '');
        if (/agree|consent|accept|privacy|terms|acknowledge/i.test(near)) await box.check({ force: true }).catch(() => {});
      }
      if (!(await clickButton(site, /^\s*(next|continue|submit|sign ?in|log ?in|login|go|start)\s*(›|>|→)?\s*$/i)) && !(await aiMove())) break;
      continue;
    }

    // Job description page → open the application
    if (inputs === 0) {
      const before = site.url();
      await openForm(site, 'form');
      if (site.url() === before && (await site.locator('input:visible').count()) === 0 && !(await aiMove())) break;
      continue;
    }

    // Signed in and on the application itself
    return await fillAndSubmit(site, site.locator('body'), name, me, qctx, dryRun, applyUrl);
  }
  return (
    (await pageAgent(site, site.context(), name, qctx, dryRun, 'could not get from sign-in to the application form')) ?? {
      status: 'needs_attention',
      note: `${name}: couldn't get from sign-in to the application form — apply yourself`,
      applyUrl: site.url(),
    }
  );
}

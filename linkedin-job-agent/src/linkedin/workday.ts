import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from 'playwright';
import { DATA_DIR, env, portalPassword } from '../config.js';
import { answerQuestion, identityAnswer, type Applicant, type QuestionContext } from '../answers.js';
import { pause } from './browser.js';
import type { ApplyResult } from './easyApply.js';

/**
 * Workday career sites (*.myworkdayjobs.com). They need an account per company, then walk
 * through steps: My Information → My Experience → Questions → Disclosures → Review → Submit.
 * Workday marks its controls with stable data-automation-id attributes, which this uses.
 */

const ACCOUNTS = path.join(DATA_DIR, 'portal-accounts.json');
type AccountState = { email: string; created: string; verified?: boolean };
const readAccounts = (): Record<string, AccountState> => {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8'));
  } catch {
    return {};
  }
};
const saveAccount = (tenant: string, a: AccountState) => fs.writeFileSync(ACCOUNTS, JSON.stringify({ ...readAccounts(), [tenant]: a }, null, 2));
export const portalAccounts = readAccounts;

const aid = (id: string) => `[data-automation-id="${id}"]`;
const visible = (l: Locator) => l.isVisible().catch(() => false);

/** Workday puts a transparent "click_filter" over many buttons; click that when present. */
async function press(site: Page, button: Locator): Promise<void> {
  const filter = button.locator('xpath=..').locator(aid('click_filter')).first();
  if (await visible(filter)) await filter.click().catch(() => button.click({ force: true }));
  else await button.click().catch(() => button.click({ force: true }));
  await site.waitForLoadState('domcontentloaded').catch(() => {});
  await pause(1500, 2500);
}

export async function workdayApply(site: Page, me: Applicant, qctx: QuestionContext, dryRun: boolean): Promise<ApplyResult> {
  const tenant = new URL(site.url()).hostname;
  const applyUrl = site.url();
  const password = portalPassword();
  if (!me.email) return { status: 'needs_attention', note: 'Workday: add your email under "My answers" first', applyUrl };
  if (!password) return { status: 'needs_attention', note: 'Workday needs an account — set a job-portal password on the dashboard so the agent can create one', applyUrl };

  // 1. Apply → choose how
  const apply = site.locator(`${aid('adventureButton')}, ${aid('applyButton')}`).first();
  if (await visible(apply)) await press(site, apply);
  for (const choice of ['useMyLastApplication', 'autofillWithResume', 'applyManually']) {
    const b = site.locator(aid(choice)).first();
    if (await visible(b)) {
      await press(site, b);
      break;
    }
  }

  // 2. Sign in, or create the account the first time
  const signedIn = await signIn(site, tenant, me.email, password);
  if (signedIn !== 'ok') return { status: 'needs_attention', note: signedIn, applyUrl };

  // 3. Resume (Workday reads it to pre-fill experience)
  const upload = site.locator(`${aid('file-upload-input-ref')}, input[type="file"]`).first();
  if ((await upload.count()) && env.resumePath) {
    await upload.setInputFiles(env.resumePath).catch(() => {});
    await pause(3000, 5000);
  }

  // 4. Walk the steps
  let lastHeading = '';
  const uploadedOn = new Set<string>();
  for (let step = 0; step < 12; step++) {
    const heading = (await site.locator(`${aid('progressBarActiveStep')}, h2, h3`).first().innerText().catch(() => '')).trim();
    // "My Experience" (or the autofill page) asks for the resume — upload it once per step
    const fileInput = site.locator(`${aid('file-upload-input-ref')}, input[type="file"]`).first();
    if (!uploadedOn.has(heading) && (await fileInput.count()) && env.resumePath) {
      const already = (await site.locator(`${aid('file-upload-successful')}, ${aid('fileName')}`).count()) > 0;
      if (!already) {
        await fileInput.setInputFiles(env.resumePath).catch(() => {});
        await pause(3000, 5000);
      }
      uploadedOn.add(heading);
    }
    const unanswered = await fillWorkdayPage(site, me, qctx);
    if (unanswered.length) {
      return { status: 'needs_attention', note: `Workday (${heading || 'form'}): couldn't answer ${unanswered.slice(0, 3).join(' | ')}`, applyUrl: site.url() };
    }
    const next = site
      .locator(`${aid('bottom-navigation-next-button')}, ${aid('bottom-navigation-next-btn')}, ${aid('pageFooterNextButton')}`)
      .or(site.locator('button').filter({ hasText: /^\s*(save and continue|next|continue|submit)\s*$/i }))
      .first();
    if (!(await visible(next))) return { status: 'needs_attention', note: `Workday (${heading}): no Next/Submit button`, applyUrl: site.url() };
    const isSubmit = /submit/i.test(await next.innerText().catch(() => ''));
    if (isSubmit && dryRun) return { status: 'dry_run', note: 'Workday: reached Submit (dry run — not sent)', applyUrl: site.url() };
    await press(site, next);
    if (isSubmit) {
      const done = await site
        .getByText(/application (has been )?(submitted|received)|thank you for applying|successfully submitted/i)
        .first()
        .waitFor({ timeout: 30000 })
        .then(() => true, () => false);
      return done
        ? { status: 'applied', note: 'submitted on Workday', applyUrl }
        : { status: 'failed', note: 'Workday: clicked Submit but saw no confirmation', applyUrl: site.url() };
    }
    const errors = (await site.locator(`${aid('errorMessage')}, ${aid('errorBanner')}, [role="alert"]`).allInnerTexts().catch(() => []))
      .map((t) => t.trim())
      .filter(Boolean);
    if (errors.length && heading === lastHeading) {
      return { status: 'needs_attention', note: `Workday (${heading}): ${errors.join(' ').slice(0, 140)}`, applyUrl: site.url() };
    }
    lastHeading = heading;
  }
  return { status: 'needs_attention', note: 'Workday: too many steps', applyUrl: site.url() };
}

/** Returns 'ok' when signed in, otherwise a note for "Needs you". */
async function signIn(site: Page, tenant: string, email: string, password: string): Promise<string> {
  const emailBox = site.locator(aid('email')).first();
  if (!(await visible(emailBox))) return 'ok'; // already signed in to this company's Workday
  const known = readAccounts()[tenant];

  if (!known) {
    // Switch to "Create Account" if the sign-in form is showing
    const create = site.locator(aid('createAccountLink')).first();
    if (await visible(create)) await press(site, create);
    await site.locator(aid('email')).first().fill(email);
    await site.locator(aid('password')).first().fill(password);
    const verify = site.locator(aid('verifyPassword')).first();
    if (await visible(verify)) await verify.fill(password);
    const agree = site.locator(aid('createAccountCheckbox')).first();
    if ((await agree.count()) && !(await agree.isChecked().catch(() => true))) await agree.check({ force: true }).catch(() => {});
    await press(site, site.locator(aid('createAccountSubmitButton')).first());
    saveAccount(tenant, { email, created: new Date().toISOString() });
    if (await site.getByText(/verify|verification (email|link)|check your email|activate your account/i).first().isVisible().catch(() => false)) {
      return `Workday sent a verification email to ${email} for ${tenant.split('.')[0]} — tap the link in it, then the next run continues`;
    }
  }

  // Sign in (also right after creating, on tenants that don't sign you in automatically)
  if (await visible(site.locator(aid('email')).first())) {
    const signInLink = site.locator(aid('signInLink')).first();
    if (await visible(signInLink)) await press(site, signInLink);
    await site.locator(aid('email')).first().fill(email);
    await site.locator(aid('password')).first().fill(password);
    await press(site, site.locator(`${aid('signInSubmitButton')}, button:has-text("Sign In")`).first());
  }
  if (await visible(site.locator(aid('email')).first())) {
    const msg = (await site.locator(`${aid('errorMessage')}, [role="alert"]`).first().innerText().catch(() => '')).trim();
    if (/verify|activate/i.test(msg)) return `Workday: verify your email for ${tenant.split('.')[0]} (link in your inbox), then the next run continues`;
    return `Workday sign-in failed for ${tenant.split('.')[0]}${msg ? `: ${msg.slice(0, 80)}` : ''} — if you already had an account there, use the same job-portal password`;
  }
  saveAccount(tenant, { email, created: known?.created ?? new Date().toISOString(), verified: true });
  return 'ok';
}

/** Fills the current Workday step; returns required questions it couldn't answer. */
async function fillWorkdayPage(site: Page, me: Applicant, qctx: QuestionContext): Promise<string[]> {
  const unanswered: string[] = [];
  const fields = site.locator(`[data-automation-id^="formField-"]`);
  for (const f of await fields.all()) {
    if (!(await visible(f))) continue;
    const label = (await f.locator('label, legend').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const required = /\*/.test(label) || (await f.locator('[aria-required="true"], [required]').count()) > 0;
    const q = label.replace(/\*/g, '').trim();

    // Text boxes (search-and-pick boxes are handled further down)
    const isSearch = (await f.locator(`${aid('searchBox')}, input[placeholder*="Search" i]`).count()) > 0;
    const input = f.locator('input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input:not([type]), textarea').first();
    if (!isSearch && (await input.count()) && (await visible(input)) && !(await input.getAttribute('role'))) {
      if (await input.inputValue().catch(() => 'x')) continue;
      const type = ((await input.getAttribute('type')) ?? 'text').toLowerCase();
      let ans = identityAnswer(q, type, me);
      if (ans === undefined) ans = await answerQuestion(q, type === 'number' ? 'number' : 'text', [], qctx);
      if (ans) await input.fill(ans);
      else if (ans !== '' && required) unanswered.push(q);
      continue;
    }

    // Workday dropdowns: a button that opens a listbox ("Select One")
    const dropdown = f.locator('button[aria-haspopup="listbox"]').first();
    if ((await dropdown.count()) && (await visible(dropdown))) {
      const current = (await dropdown.innerText().catch(() => '')).trim();
      if (current && !/^select one$/i.test(current)) continue;
      await dropdown.click().catch(() => {});
      const opts = site.locator('[role="listbox"] [role="option"]');
      await opts.first().waitFor({ timeout: 4000 }).catch(() => {});
      const options = (await opts.allInnerTexts().catch(() => [])).map((o) => o.trim()).filter((o) => o && !/^select one$/i.test(o));
      const ident = identityAnswer(q, 'text', me);
      const ans = ident && options.includes(ident) ? ident : await answerQuestion(q, 'select', options, qctx);
      if (ans) await opts.filter({ hasText: new RegExp(`^\\s*${ans.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }).first().click().catch(() => {});
      else {
        await site.keyboard.press('Escape').catch(() => {});
        if (required) unanswered.push(q);
      }
      continue;
    }

    // Search-and-pick lists, e.g. "How did you hear about us?"
    const search = f.locator(`${aid('searchBox')}, input[placeholder*="Search" i]`).first();
    if ((await search.count()) && (await visible(search))) {
      if ((await f.locator(aid('selectedItem')).count()) > 0) continue;
      const ans = identityAnswer(q, 'text', me) ?? (await answerQuestion(q, 'text', [], qctx));
      if (!ans) {
        if (required) unanswered.push(q);
        continue;
      }
      await search.fill(ans);
      await search.press('Enter').catch(() => {});
      await pause(1200, 2000);
      const first = site.locator(`${aid('promptOption')}, [role="option"]`).first();
      if (await visible(first)) await first.click().catch(() => {});
      continue;
    }

    // Radio groups
    const radios = f.locator('input[type="radio"]');
    if (await radios.count()) {
      if ((await f.locator('input[type="radio"]:checked').count()) > 0) continue;
      const labels = (await f.locator('label').allInnerTexts()).map((t) => t.trim()).filter((t) => t && t !== label);
      const ans = await answerQuestion(q, 'radio', labels, qctx);
      if (ans) await f.locator('label').filter({ hasText: ans }).first().click().catch(() => {});
      else if (required) unanswered.push(q);
      continue;
    }

    // Checkboxes: terms / consent
    const box = f.locator('input[type="checkbox"]').first();
    if ((await box.count()) && !(await box.isChecked().catch(() => true))) {
      if (/agree|consent|acknowledge|terms|certify|confirm|i understand/i.test(q)) await box.check({ force: true }).catch(() => {});
      else if (required) unanswered.push(q);
    }
  }
  // Stand-alone terms checkbox on the review / disclosures step
  const terms = site.locator(aid('agreementCheckbox')).first();
  if ((await terms.count()) && !(await terms.isChecked().catch(() => true))) await terms.check({ force: true }).catch(() => {});
  return [...new Set(unanswered)];
}

import type { Locator, Page } from 'playwright';
import { env } from '../config.js';
import { answerQuestion, type FieldKind, type QuestionContext } from '../answers.js';
import { pause } from './browser.js';
import { applyButton } from './jobs.js';

export interface ApplyResult {
  status: 'applied' | 'dry_run' | 'needs_attention' | 'failed';
  note: string;
  /** Where the application lives (company site), if not on LinkedIn */
  applyUrl?: string;
}

const MAX_STEPS = 12;

/** Opens Easy Apply on the current job page and walks the form. Never guesses answers. */
export async function easyApply(page: Page, ctx: QuestionContext, dryRun: boolean): Promise<ApplyResult> {
  const btn = applyButton(page);
  if (!(await btn.isVisible().catch(() => false))) return { status: 'failed', note: 'Easy Apply button not found' };
  await btn.click();
  // Classic LinkedIn opens a dialog; the newer one opens the form as its own page (/apply/)
  const modal = page.locator('div[role="dialog"]').filter({ has: page.locator('form, button') }).first();
  await Promise.race([modal.waitFor({ timeout: 20000 }), page.waitForURL(/\/apply\//, { timeout: 20000 })]).catch(() => {});
  const dialog = (await modal.isVisible().catch(() => false))
    ? modal
    : /\/apply\//.test(page.url())
      ? page.locator('main, body').first()
      : null;
  if (!dialog) return { status: 'failed', note: 'Easy Apply form did not open' };

  let lastSignature = '';
  for (let step = 0; step < MAX_STEPS; step++) {
    await pause(800, 1600);
    const unanswered = await fillStep(dialog, ctx);
    if (unanswered.length) {
      await discard(page);
      return { status: 'needs_attention', note: `couldn't answer: ${unanswered.slice(0, 3).join(' | ')}` };
    }

    const submit = dialog.locator('button[aria-label="Submit application"], button:has-text("Submit application")').first();
    if (await submit.isVisible().catch(() => false)) {
      if (dryRun) {
        await discard(page);
        return { status: 'dry_run', note: 'reached Submit (dry run — not sent)' };
      }
      await uncheckFollowCompany(dialog);
      await submit.click();
      const sent = await page
        .getByText(/application (was )?sent|you applied|applied \d|your application was sent/i)
        .first()
        .waitFor({ timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      await page.locator('button[aria-label="Dismiss"]').first().click({ timeout: 3000 }).catch(() => {});
      return sent ? { status: 'applied', note: 'submitted' } : { status: 'failed', note: 'clicked Submit but no confirmation seen' };
    }

    const next = dialog
      .locator('button[aria-label="Review your application"], button[aria-label="Continue to next step"], button:has-text("Review"), button:has-text("Next")')
      .first();
    if (!(await next.isVisible().catch(() => false))) {
      await discard(page);
      return { status: 'failed', note: 'no Next/Review/Submit button' };
    }
    await next.click();
    await pause(800, 1400);

    const errors = await dialog.locator('.artdeco-inline-feedback--error, [role="alert"]').allInnerTexts().catch(() => []);
    const signature = (await dialog.innerText().catch(() => '')).slice(0, 500);
    if (errors.some((e) => e.trim()) && signature === lastSignature) {
      await discard(page);
      return { status: 'needs_attention', note: `form error: ${errors.join(' ').trim().slice(0, 140)}` };
    }
    lastSignature = signature;
  }
  await discard(page);
  return { status: 'failed', note: 'too many steps' };
}

async function labelFor(dialog: Locator, el: Locator): Promise<string> {
  const id = await el.getAttribute('id');
  if (id) {
    const t = await dialog.locator(`label[for="${id}"]`).first().innerText({ timeout: 500 }).catch(() => '');
    if (t.trim()) return t.trim();
  }
  return ((await el.getAttribute('aria-label')) ?? (await el.getAttribute('placeholder')) ?? '').trim();
}

/** Fills every empty field on the current step; returns questions it couldn't answer. */
async function fillStep(dialog: Locator, ctx: QuestionContext): Promise<string[]> {
  const unanswered: string[] = [];
  const isOptional = (label: string) => /optional/i.test(label);

  // Text / number / textarea
  for (const el of await dialog.locator('input[type="text"], input[type="tel"], input[type="email"], input[type="number"], input:not([type]), textarea').all()) {
    if (!(await el.isVisible().catch(() => false)) || (await el.inputValue().catch(() => 'x'))) continue;
    const label = await labelFor(dialog, el);
    const tag = await el.evaluate((e) => e.tagName.toLowerCase());
    const type = (await el.getAttribute('type')) ?? '';
    const id = (await el.getAttribute('id')) ?? '';
    const kind: FieldKind = type === 'number' || /numeric/.test(id) ? 'number' : tag === 'textarea' ? 'textarea' : 'text';
    const ans = await answerQuestion(label, kind, [], ctx);
    if (ans === null) {
      if (!isOptional(label)) unanswered.push(label || '(unlabelled field)');
      continue;
    }
    await el.fill(ans);
    // City and similar fields are typeaheads: pick the first suggestion
    if ((await el.getAttribute('role')) === 'combobox' || (await el.getAttribute('aria-autocomplete'))) {
      await pause(800, 1200);
      await el.press('ArrowDown').catch(() => {});
      await el.press('Enter').catch(() => {});
    }
  }

  // Dropdowns
  for (const sel of await dialog.locator('select').all()) {
    if (!(await sel.isVisible().catch(() => false))) continue;
    const current = await sel.evaluate((s: HTMLSelectElement) => s.options[s.selectedIndex]?.text ?? '');
    if (current && !/select an option/i.test(current)) continue;
    const label = await labelFor(dialog, sel);
    const options = await sel.evaluate((s: HTMLSelectElement) => Array.from(s.options).map((o) => o.text.trim()));
    const ans = await answerQuestion(label, 'select', options, ctx);
    if (ans === null) unanswered.push(label);
    else await sel.selectOption({ label: ans });
  }

  // Radio groups and required checkboxes
  for (const fs of await dialog.locator('fieldset').all()) {
    if (!(await fs.isVisible().catch(() => false))) continue;
    const legend = (await fs.locator('legend').first().innerText({ timeout: 500 }).catch(() => '')).trim();
    const radios = fs.locator('input[type="radio"]');
    const boxes = fs.locator('input[type="checkbox"]');
    if (await radios.count()) {
      if ((await fs.locator('input[type="radio"]:checked').count()) > 0) continue;
      const labels = (await fs.locator('label').allInnerTexts()).map((s) => s.trim()).filter(Boolean);
      const ans = await answerQuestion(legend, 'radio', labels, ctx);
      if (ans === null) unanswered.push(legend);
      else await fs.locator('label').filter({ hasText: ans }).first().click();
    } else if ((await boxes.count()) && (await fs.locator('input[type="checkbox"]:checked').count()) === 0) {
      if (/agree|consent|acknowledge|terms|confirm/i.test(legend)) await fs.locator('label').first().click();
      else if (!isOptional(legend) && /\*|required/i.test(legend)) unanswered.push(legend);
    }
  }

  // Resume upload (LinkedIn usually pre-selects your last resume; only upload if none chosen)
  const file = dialog.locator('input[type="file"]').first();
  if ((await file.count()) && env.resumePath) {
    const chosen = await dialog.locator('[aria-label*="Selected" i], .jobs-document-upload-redesign-card__container--selected, input[type="radio"][name*="resume" i]:checked').count();
    const isResume = /resume|cv/i.test(await dialog.innerText().catch(() => ''));
    if (!chosen && isResume) await file.setInputFiles(env.resumePath).catch(() => {});
  }

  return unanswered.filter(Boolean);
}

async function uncheckFollowCompany(dialog: Locator) {
  const follow = dialog.locator('#follow-company-checkbox');
  if (await follow.isChecked().catch(() => false)) {
    await dialog.locator('label[for="follow-company-checkbox"]').click().catch(() => {});
  }
}

async function discard(page: Page) {
  await page.locator('div[role="dialog"] button[aria-label="Dismiss"]').first().click({ timeout: 3000 }).catch(() => {});
  await page
    .locator('button[data-control-name="discard_application_confirm_btn"], button:has-text("Discard")')
    .first()
    .click({ timeout: 3000 })
    .catch(() => {});
}

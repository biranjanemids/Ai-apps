import type { Page } from 'playwright';
import type { Experience, Profile } from '../profile.js';
import { yearsFromExperiences } from '../profile.js';
import { cleanLines, pause, setSession } from './browser.js';

const EMPLOYMENT_TYPE = /^(full-time|part-time|contract|internship|freelance|self-employed|apprenticeship|seasonal|trainee)/i;
const DATE_LINE = /((19|20)\d{2}|present)/i;

/** Reads your own LinkedIn profile: headline, experience (incl. current employer) and skills. */
export async function scrapeOwnProfile(page: Page): Promise<Omit<Profile, 'resumeText'>> {
  await page.goto('https://www.linkedin.com/in/me/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  // /in/me/ redirects to /in/<your-handle>/; slow phones can take a while
  await page.waitForURL(/linkedin\.com\/(in\/(?!me\/)[^/]+|authwall|login|checkpoint|uas)/, { timeout: 45000 }).catch(() => {});
  if (/\/(authwall|login|checkpoint|uas)/.test(page.url())) {
    setSession(false);
    throw new Error(`LinkedIn asked to log in again (${page.url().split('?')[0]}). Tap "Connect LinkedIn" on the dashboard.`);
  }
  const h1 = page.locator('main h1, h1').first();
  if (!(await h1.waitFor({ timeout: 60000 }).then(() => true, () => false))) {
    const title = await page.title().catch(() => '');
    throw new Error(`Profile page didn't load (at ${page.url().split('?')[0]}, page title "${title}")`);
  }
  const profileUrl = page.url().split('?')[0].replace(/\/$/, '');
  const name = (await h1.innerText()).trim();
  const headline = (
    (await page.locator('main .text-body-medium, .text-body-medium').first().innerText({ timeout: 5000 }).catch(() => '')) || ''
  ).trim();

  const experiences = parseExperience(await detailsItems(page, `${profileUrl}/details/experience/`));
  const skills = (await detailsItems(page, `${profileUrl}/details/skills/`))
    .map((lines) => lines[0])
    .filter((s) => s && s.length < 60 && !/endorse/i.test(s));

  return {
    name,
    headline,
    profileUrl,
    experiences,
    skills: [...new Set(skills)],
    totalYears: yearsFromExperiences(experiences),
    updatedAt: new Date().toISOString(),
  };
}

/** Top-level list items of a /details/* page, each as cleaned text lines. */
async function detailsItems(page: Page, url: string): Promise<string[][]> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main ul li', { timeout: 20000 }).catch(() => {});
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 3000);
    await pause(500, 900);
  }
  const texts = await page.$$eval('main section ul > li', (lis) =>
    lis
      // only top-level items, not nested role lists
      .filter((li) => !li.parentElement?.closest('li'))
      .map((li) => (li as HTMLElement).innerText),
  );
  return texts.map(cleanLines).filter((l) => l.length > 0);
}

/**
 * Handles both layouts LinkedIn uses:
 *  single role:  [Title, "Company · Full-time", "Jan 2020 - Present · 4 yrs", ...]
 *  grouped:      [Company, "Full-time · 6 yrs", Title1, "Jan 2022 - Present", Title2, ...]
 */
export function parseExperience(items: string[][]): Experience[] {
  const out: Experience[] = [];
  for (const raw of items) {
    const lines = cleanLines(raw.join('\n'));
    const second = lines[1] ?? '';
    const grouped = (EMPLOYMENT_TYPE.test(second) || /^\d+\s*(yrs?|mos?)/.test(second)) && !second.includes(' - ');
    if (grouped) {
      const company = lines[0];
      for (let i = 2; i < lines.length; i++) {
        if (DATE_LINE.test(lines[i]) && / - |–/.test(lines[i]) && i > 2) {
          const title = EMPLOYMENT_TYPE.test(lines[i - 1]) ? lines[i - 2] : lines[i - 1];
          out.push({ title, company, dates: lines[i], current: /present/i.test(lines[i]) });
        }
      }
    } else {
      const dates = lines.find((l) => DATE_LINE.test(l) && / - |–/.test(l)) ?? '';
      const company = (second.split(' · ')[0] ?? '').trim();
      if (!lines[0] || !company) continue;
      out.push({ title: lines[0], company, dates, current: /present/i.test(dates) });
    }
  }
  return out;
}

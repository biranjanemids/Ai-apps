import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { DATA_DIR } from '../config.js';
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
  // LinkedIn's newer profile layout has no <h1>; the tab title ("Name | LinkedIn") always has the name
  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
  const titleName = (await page.title().catch(() => '')).replace(/^\(\d+\+?\)\s*/, '').replace(/\s*\|\s*LinkedIn.*$/i, '').trim();
  const heading = await page.locator('main h1, h1').first().innerText({ timeout: 15000 }).catch(() => '');
  const name = (heading.trim().length > 1 && heading.trim().length < 80 ? heading : titleName).trim();
  if (!name) {
    throw new Error(`Profile page didn't load (at ${page.url().split('?')[0]}, page title "${await page.title().catch(() => '')}")`);
  }
  const profileUrl = page.url().split('?')[0].replace(/\/$/, '');
  const headline = (
    (await page.locator('main .text-body-medium, .text-body-medium').first().innerText({ timeout: 5000 }).catch(() => '')) || ''
  ).trim();

  const exp = await detailsPage(page, `${profileUrl}/details/experience/`);
  let experiences = parseExperience(exp.items);
  if (!experiences.length) experiences = parseExperienceText(exp.lines);
  fs.writeFileSync(path.join(DATA_DIR, 'debug-experience.txt'), exp.lines.join('\n'));

  const sk = await detailsPage(page, `${profileUrl}/details/skills/`);
  const skills = sk.items
    .map((lines) => lines[0])
    .filter((x) => x && x.length < 60 && !/endorse/i.test(x));

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

/**
 * A /details/* page as list items (each as cleaned text lines) plus the page's whole visible
 * text, so parsing still works if LinkedIn changes its list markup.
 */
async function detailsPage(page: Page, url: string): Promise<{ items: string[][]; lines: string[] }> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('main ul li, main li, li', { timeout: 30000 }).catch(() => {});
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
  const all = await page.locator('main').first().innerText({ timeout: 5000 }).catch(() => page.locator('body').innerText().catch(() => ''));
  return { items: texts.map(cleanLines).filter((l) => l.length > 0), lines: cleanLines(all) };
}

const DATE_RANGE = /((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?(19|20)\d{2}\s*(-|–|—)\s*(present|((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?(19|20)\d{2})/i;
const GROUP_SUMMARY = /^((full-time|part-time|contract|internship|freelance|self-employed)\s*·\s*)?\d+\s*(yrs?|mos?)\b/i;

/**
 * Layout-independent fallback: find each "Mar 2021 - Present" line in the page text and read
 * the role/company from the lines just above it.
 */
export function parseExperienceText(lines: string[]): Experience[] {
  const out: Experience[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!DATE_RANGE.test(lines[i])) continue;
    const above = lines[i - 1];
    let title = '';
    let company = '';
    if (above.includes(' · ') && !EMPLOYMENT_TYPE.test(above)) {
      // single role: Title / "Company · Full-time" / dates
      company = above.split(' · ')[0];
      title = lines[i - 2] ?? '';
    } else {
      // grouped roles: Company / "Full-time · 6 yrs" / Title / [Full-time] / dates
      title = EMPLOYMENT_TYPE.test(above) ? (lines[i - 2] ?? '') : above;
      for (let j = i - 1; j > 0; j--) {
        if (GROUP_SUMMARY.test(lines[j])) {
          company = lines[j - 1];
          break;
        }
      }
    }
    if (title && company && !DATE_RANGE.test(title)) {
      out.push({ title: title.trim(), company: company.trim(), dates: lines[i], current: /present/i.test(lines[i]) });
    }
  }
  return out;
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

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, env } from './config.js';
import { extractSkillsFromText } from './matching.js';

export interface Experience {
  title: string;
  company: string;
  dates: string;
  current: boolean;
}

export interface Profile {
  name: string;
  headline: string;
  profileUrl: string;
  experiences: Experience[];
  skills: string[];
  /** Years since the earliest role start (or YEARS_EXPERIENCE override). */
  totalYears: number;
  resumeText: string;
  updatedAt: string;
}

const FILE = path.join(DATA_DIR, 'profile.json');

export function loadProfile(): Profile | null {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function saveProfile(p: Profile): void {
  fs.writeFileSync(FILE, JSON.stringify(p, null, 2));
}

export const currentEmployers = (p: Profile | null): string[] =>
  [...new Set((p?.experiences ?? []).filter((e) => e.current && e.company).map((e) => e.company))];

/** Titles you've held — used to derive search keywords and title match. */
export const profileTitles = (p: Profile): string[] =>
  [...new Set([p.headline.split(/[|@,]| at /i)[0].trim(), ...p.experiences.map((e) => e.title)].filter(Boolean))];

export async function readResumeText(): Promise<string> {
  const file = env.resumePath;
  if (!file || !fs.existsSync(file)) return '';
  if (file.toLowerCase().endsWith('.pdf')) {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: fs.readFileSync(file) });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  }
  return fs.readFileSync(file, 'utf8');
}

/** Merge resume-only skills into the LinkedIn profile so matching uses both. */
export function mergeResume(p: Profile, resumeText: string): Profile {
  const extra = extractSkillsFromText(resumeText);
  const have = new Set(p.skills.map((s) => s.toLowerCase()));
  return { ...p, resumeText, skills: [...p.skills, ...extra.filter((s) => !have.has(s.toLowerCase()))] };
}

const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');

/** "Jan 2019 - Present · 5 yrs" → years since the earliest start date across roles. */
export function yearsFromExperiences(exps: Experience[], now = new Date()): number {
  let earliest: number | null = null;
  for (const e of exps) {
    const m = e.dates.match(/([A-Za-z]{3})?[a-z]*\.?\s*((?:19|20)\d{2})/);
    if (!m) continue;
    const month = m[1] ? Math.max(0, MONTHS.indexOf(m[1].toLowerCase())) : 0;
    const t = Number(m[2]) * 12 + month;
    if (earliest === null || t < earliest) earliest = t;
  }
  if (earliest === null) return 0;
  const months = now.getFullYear() * 12 + now.getMonth() - earliest;
  return Math.max(0, Math.round((months / 12) * 10) / 10);
}

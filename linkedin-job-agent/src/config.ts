import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const list = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};
const bool = (v: string | undefined, d: boolean): boolean =>
  v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v);

/** Git commit of the installed code, so a stale running dashboard can be spotted. */
export const VERSION = (() => {
  try {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return 'unknown';
  }
})();

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

/** Static config from .env. Values the phone dashboard can change live are in `Settings`. */
export const env = {
  port: num(process.env.PORT, 8787),
  host: process.env.HOST ?? '0.0.0.0',
  dashboardToken: process.env.DASHBOARD_TOKEN ?? '',
  headless: bool(process.env.HEADLESS, true),
  chromePath: process.env.CHROME_PATH || undefined,
  liAt: process.env.LINKEDIN_LI_AT || undefined,
  location: process.env.JOB_LOCATION ?? 'Bengaluru, Karnataka, India',
  geoId: process.env.JOB_GEO_ID ?? '105214831', // LinkedIn geoId for Bengaluru
  /** RESUME_PATH, else a resume uploaded from the phone dashboard. */
  get resumePath(): string | undefined {
    if (process.env.RESUME_PATH && fs.existsSync(process.env.RESUME_PATH)) return process.env.RESUME_PATH;
    return ['resume.pdf', 'resume.txt'].map((f) => path.join(DATA_DIR, f)).find((f) => fs.existsSync(f));
  },
  /** GROQ_API_KEY from .env, or a key saved from the dashboard */
  get groqApiKey(): string | undefined {
    if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
    try {
      return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'secrets.json'), 'utf8')).groqApiKey || undefined;
    } catch {
      return undefined;
    }
  },
  /** Optional: force a Groq model; otherwise the best available one is picked automatically */
  groqModel: process.env.GROQ_MODEL || '',
  ntfyTopic: process.env.NTFY_TOPIC || undefined,
  runEveryMinutes: num(process.env.RUN_EVERY_MINUTES, 0),
  maxPerDay: num(process.env.MAX_APPLICATIONS_PER_DAY, 40),
  maxJobsScannedPerKeyword: num(process.env.MAX_JOBS_SCANNED_PER_KEYWORD, 50),
  answersPath: path.resolve(process.env.ANSWERS_PATH ?? 'answers.json'),
};

export interface Settings {
  /** Companies the agent must never apply to (your employer, its parent/group/subsidiaries). */
  excludedCompanies: string[];
  /** Add the current employer(s) detected on your LinkedIn profile to the exclusion list. */
  autoExcludeCurrentEmployer: boolean;
  /** Search keywords; empty = derive from your profile headline/titles. */
  keywords: string[];
  /** Skip jobs whose title contains any of these words. */
  excludedTitleWords: string[];
  /** Minimum match score (0-100) required to apply. */
  minScore: number;
  maxPerRun: number;
  /** Walk the whole Easy Apply form but stop before "Submit". */
  dryRun: boolean;
  /** r86400 = 24h, r604800 = week, r2592000 = month */
  postedWithin: 'r86400' | 'r604800' | 'r2592000';
  /** Start a run by itself every N hours (0 = only when you tap Run). */
  autoRunHours: number;
  /** Use AI (when a Groq key is set) for scoring, open questions, keywords and cover notes. */
  useAI: boolean;
  /** 'all' = Easy Apply + company-site jobs; 'easy' = LinkedIn Easy Apply only. */
  applyMode: 'all' | 'easy';
  /** Overrides experience detected from the profile/resume. */
  yearsExperience: number | null;
}

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function defaults(): Settings {
  const years = process.env.YEARS_EXPERIENCE;
  return {
    excludedCompanies: list(process.env.EXCLUDED_COMPANIES),
    autoExcludeCurrentEmployer: bool(process.env.AUTO_EXCLUDE_CURRENT_EMPLOYER, true),
    keywords: list(process.env.KEYWORDS),
    excludedTitleWords: list(process.env.EXCLUDED_TITLE_WORDS ?? 'intern,internship,trainee'),
    minScore: num(process.env.MIN_MATCH_SCORE, 55),
    maxPerRun: num(process.env.MAX_APPLICATIONS_PER_RUN, 15),
    dryRun: bool(process.env.DRY_RUN, true),
    postedWithin: (process.env.POSTED_WITHIN as Settings['postedWithin']) || 'r604800',
    yearsExperience: years ? Number(years) : null,
    applyMode: process.env.APPLY_MODE === 'easy' ? 'easy' : 'all',
    useAI: bool(process.env.USE_AI, true),
    autoRunHours: num(process.env.RUN_EVERY_MINUTES, 0) / 60,
  };
}

export function loadSettings(): Settings {
  const base = defaults();
  try {
    return { ...base, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return base;
  }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(), ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

/** Your standard answers for Easy Apply screening questions (answers.json). */
export interface Answers {
  phone?: string;
  email?: string;
  city?: string;
  addressLine1?: string;
  postalCode?: string;
  state?: string;
  noticePeriodDays?: number;
  currentCtcLakhs?: number;
  expectedCtcLakhs?: number;
  linkedinUrl?: string;
  portfolioUrl?: string;
  authorizedToWorkInIndia?: boolean;
  requiresSponsorship?: boolean;
  willingToRelocate?: boolean;
  comfortableOnsite?: boolean;
  /** Extra rules: if the question contains `match` (case-insensitive regex), answer `answer`. */
  custom?: { match: string; answer: string }[];
}

export function saveAnswers(a: Answers): void {
  fs.writeFileSync(env.answersPath, JSON.stringify(a, null, 2));
}

export function loadAnswers(): Answers {
  try {
    return JSON.parse(fs.readFileSync(env.answersPath, 'utf8'));
  } catch {
    return {};
  }
}

const SECRETS = path.join(DATA_DIR, 'secrets.json');
function readSecrets(): { groqApiKey?: string; portalPassword?: string } {
  try {
    return JSON.parse(fs.readFileSync(SECRETS, 'utf8'));
  } catch {
    return {};
  }
}
function saveSecret(patch: { groqApiKey?: string; portalPassword?: string }): void {
  fs.writeFileSync(SECRETS, JSON.stringify({ ...readSecrets(), ...patch }), { mode: 0o600 });
}

export const saveGroqKey = (key: string) => saveSecret({ groqApiKey: key.trim() });
/** Password the agent uses to create/sign in to company job portals (Workday etc.). */
export const savePortalPassword = (pw: string) => saveSecret({ portalPassword: pw });
export const portalPassword = (): string | undefined => process.env.PORTAL_PASSWORD || readSecrets().portalPassword || undefined;

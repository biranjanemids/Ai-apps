import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

/**
 * What the agent has learned about each careers site: which buttons led to the application
 * form, and how applying there went. Sites it has never seen are handled by the AI page agent;
 * what worked is replayed next time without asking the AI again.
 */

const FILE = path.join(DATA_DIR, 'site-memory.json');

export interface SiteMemo {
  /** Button/link texts that led from the job page to the form, in order */
  nav: string[];
  applied: number;
  failed: number;
  /** Handled by the AI page agent (no built-in support for this site) */
  learned?: boolean;
  lastNote?: string;
  at: string;
}

export function readMemory(): Record<string, SiteMemo> {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Sites are remembered by domain, e.g. "jobs.baxter.com" → "baxter.com". */
export function siteKey(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    const tail = parts.slice(-2).join('.');
    // keep the tenant for shared platforms (acme.icims.com, acme.wd1.myworkdayjobs.com)
    return /^(co|com|ac|gov|org|net)\.[a-z]{2}$/.test(tail) || /icims|myworkdayjobs|taleo|successfactors|oraclecloud|greenhouse|lever|ashbyhq|smartrecruiters/.test(host)
      ? parts.slice(-3).join('.')
      : tail;
  } catch {
    return url;
  }
}

function update(url: string, fn: (m: SiteMemo) => void) {
  const all = readMemory();
  const key = siteKey(url);
  const m = all[key] ?? { nav: [], applied: 0, failed: 0, at: '' };
  fn(m);
  m.at = new Date().toISOString();
  all[key] = m;
  try {
    fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
  } catch {
    // memory is a nice-to-have
  }
}

export const rememberNav = (url: string, nav: string[]) =>
  nav.length && update(url, (m) => (m.nav = nav.slice(0, 6)));

export const rememberOutcome = (url: string, status: string, note: string, learned = false) =>
  update(url, (m) => {
    if (status === 'applied' || status === 'dry_run') m.applied++;
    else m.failed++;
    if (learned) m.learned = true;
    m.lastNote = note.slice(0, 160);
  });

export const navFor = (url: string): string[] => readMemory()[siteKey(url)]?.nav ?? [];

// The clicks of the application in progress, saved for the site once it succeeds
let trail: { url: string; clicks: string[] } | null = null;
export const startTrail = (url: string) => (trail = { url, clicks: [] });
export const trailClick = (text: string) => trail && trail.clicks.length < 6 && trail.clicks.push(text);
export const saveTrail = () => trail && rememberNav(trail.url, trail.clicks);

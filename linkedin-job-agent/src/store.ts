import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export type JobStatus =
  | 'applied'
  | 'dry_run'
  | 'excluded' // employer / parent company — never applied
  | 'skipped' // low match, wrong location, title filter, not Easy Apply…
  | 'needs_attention' // form had a question the agent can't answer truthfully
  | 'failed';

export interface JobRecord {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  score: number;
  reasons: string[];
  status: JobStatus;
  note?: string;
  /** Company application page, for jobs you finish yourself */
  applyUrl?: string;
  /** Scoring version that produced `score`; older low-match skips get re-checked */
  v?: number;
  at: string;
}

const FILE = path.join(DATA_DIR, 'jobs.json');

function read(): Record<string, JobRecord> {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

let cache = read();

export const store = {
  get: (id: string): JobRecord | undefined => cache[id],
  save(rec: JobRecord): void {
    cache[rec.id] = rec;
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
  },
  list(status?: JobStatus): JobRecord[] {
    return Object.values(cache)
      .filter((r) => !status || r.status === status)
      .sort((a, b) => b.at.localeCompare(a.at));
  },
  /** Applications submitted today (India time). */
  appliedToday(): number {
    const today = istDate(new Date());
    return Object.values(cache).filter((r) => r.status === 'applied' && istDate(new Date(r.at)) === today).length;
  },
  counts(): Record<string, number> {
    const c: Record<string, number> = {};
    for (const r of Object.values(cache)) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  },
  /** Forget jobs that weren't applied to, so the next run checks them again. */
  forgetUnapplied(): number {
    let n = 0;
    for (const [id, r] of Object.entries(cache)) {
      if (r.status === 'skipped' || r.status === 'failed' || r.status === 'dry_run') {
        delete cache[id];
        n++;
      }
    }
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
    return n;
  },
  reload(): void {
    cache = read();
  },
};

const istDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

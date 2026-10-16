import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, env, loadAnswers, loadSettings } from './config.js';
import { effectiveExclusions } from './agent.js';
import { getSession, isLoggedIn, openBrowser, userAgent } from './linkedin/browser.js';
import { currentEmployers, loadProfile, readResumeText } from './profile.js';
import { store } from './store.js';

type Level = 'ok' | 'warn' | 'fail';
const ICON: Record<Level, string> = { ok: '✅', warn: '⚠️ ', fail: '❌' };
const results: Level[] = [];

function line(level: Level, label: string, detail = '') {
  results.push(level);
  console.log(`${ICON[level]} ${label}${detail ? ` — ${detail}` : ''}`);
}

const timed = async <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s`)), ms))]);

/** One-command health check; paste its output when asking for help. */
export async function doctor(): Promise<void> {
  console.log('LinkedIn Job Agent — health check\n');

  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 20 ? 'ok' : 'fail', `Node.js ${process.versions.node}`, major >= 20 ? '' : 'needs 20+: pkg install nodejs-lts');
  console.log(`   platform: ${process.platform}/${process.arch}`);

  // Dashboard server
  let busy = false;
  try {
    const res = await timed(fetch(`http://127.0.0.1:${env.port}/api/status`, { headers: { Authorization: `Bearer ${env.dashboardToken}` } }), 5000);
    if (res.ok) {
      const s = (await res.json()) as { busy: boolean; running: boolean };
      busy = s.busy;
      line('ok', `Dashboard running on port ${env.port}`, s.running ? 'a job search is running now' : s.busy ? 'busy (login or profile sync)' : 'idle');
    } else {
      line('fail', 'Dashboard answered with an error', `HTTP ${res.status}${res.status === 401 ? ' (DASHBOARD_TOKEN mismatch)' : ''}`);
    }
  } catch {
    line('warn', 'Dashboard not running', 'start it with: bash termux/start.sh');
  }
  if (env.dashboardToken.length < 16) line('fail', 'DASHBOARD_TOKEN missing or too short in .env');

  // Browser
  const chrome = env.chromePath;
  if (process.platform === 'android') {
    line(chrome && fs.existsSync(chrome) ? 'ok' : 'fail', 'Chromium installed', chrome ?? 'not found: pkg install x11-repo && pkg install chromium');
  }

  // Network
  try {
    const res = await timed(fetch('https://www.linkedin.com/', { redirect: 'manual' }), 15000);
    line('ok', 'Internet → linkedin.com reachable', `HTTP ${res.status}`);
  } catch (e) {
    line('fail', 'Cannot reach linkedin.com', (e as Error).message);
  }

  // Browser launch + live login check (skipped while the agent uses the browser profile)
  if (busy) {
    line('warn', 'Skipped browser test', 'agent is busy — run the check again when it is idle');
  } else {
    const t0 = Date.now();
    try {
      const ctx = await timed(openBrowser(), 60000);
      try {
        line('ok', 'Browser starts', `${((Date.now() - t0) / 1000).toFixed(1)}s`);
        const page = ctx.pages()[0] ?? (await ctx.newPage());
        try {
          const ok = await timed(isLoggedIn(page), 45000);
          line(ok ? 'ok' : 'fail', ok ? 'Logged in to LinkedIn' : 'Not logged in to LinkedIn', ok ? '' : 'tap "Connect LinkedIn" on the dashboard');
        } catch (e) {
          line('fail', 'Browser could not open LinkedIn', (e as Error).message.split('\n')[0]);
        }
      } finally {
        await ctx.close().catch(() => {});
      }
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0];
      line('fail', 'Browser failed to start', msg);
      const s = getSession();
      if (s) console.log(`   last known LinkedIn login: ${s.loggedIn ? 'yes' : 'no'} (${s.at})`);
    }
  }

  // Profile & resume
  const profile = loadProfile();
  if (!profile) line('fail', 'No profile yet', 'upload your resume and connect LinkedIn');
  else {
    line(profile.profileUrl ? 'ok' : 'warn', profile.profileUrl ? `Profile read from LinkedIn: ${profile.name}` : 'Profile only from resume', profile.profileUrl ? profile.headline : 'connect LinkedIn so your company is detected');
    console.log(`   ${profile.skills.length} skills, ${profile.totalYears} yrs experience, updated ${profile.updatedAt.slice(0, 16).replace('T', ' ')}`);
  }
  if (!env.resumePath) line('warn', 'No resume', 'upload it on the Resume card');
  else if (profile?.resumeText) line('ok', 'Resume read', `${profile.resumeText.length} characters`);
  else {
    try {
      const text = await readResumeText();
      line(text.trim() ? 'warn' : 'fail', text.trim() ? `Resume readable (${text.length} characters) but not loaded yet` : 'Resume has no readable text', text.trim() ? 'upload it again on the Resume card' : 'scanned image? upload a text-based PDF');
    } catch (e) {
      line('fail', 'Resume could not be read', (e as Error).message.split('\n')[0]);
    }
  }

  // Company blocking
  const settings = loadSettings();
  const ex = effectiveExclusions(settings, profile);
  const detected = currentEmployers(profile);
  line(ex.length ? 'ok' : 'fail', ex.length ? `Never applying to: ${ex.join(', ')}` : 'Company block list is EMPTY', ex.length ? '' : 'add your company under "Never apply to"');
  if (profile?.profileUrl && !detected.length) line('warn', 'No current employer found on your LinkedIn profile', 'add your company manually');

  // Answers
  const a = loadAnswers();
  const missing = (['phone', 'noticePeriodDays', 'currentCtcLakhs', 'expectedCtcLakhs'] as const).filter((k) => a[k] === undefined);
  line(missing.length ? 'warn' : 'ok', missing.length ? `Answers missing: ${missing.join(', ')}` : 'Application answers filled', missing.length ? 'more jobs will land in "Needs you"' : '');

  // Activity
  const c = store.counts();
  line('ok', `Mode: ${settings.dryRun ? 'DRY RUN (nothing is submitted)' : 'LIVE'}`, `min match ${settings.minScore}%, max ${settings.maxPerRun}/run, ${env.maxPerDay}/day`);
  const total = Object.values(c).reduce((x, y) => x + y, 0);
  if (!total) line('warn', 'No jobs processed yet', 'tap "Find jobs (dry run)"');
  else {
    console.log(`   jobs: ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ')}; applied today ${store.appliedToday()}`);
    const recent = store.list().slice(0, 3);
    for (const r of recent) console.log(`   · ${r.status}: ${r.title} @ ${r.company}${r.note ? ` (${r.note})` : ''}`);
  }
  const logFile = path.join(DATA_DIR, 'agent.log');
  if (fs.existsSync(logFile)) {
    const log = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    const summary = log.filter((l) => /Checked \d+ jobs|": \d+ (Easy Apply )?jobs in|Applied to \d+|Dry run done/.test(l)).slice(-4);
    if (summary.length) {
      console.log('   last run:');
      summary.forEach((l) => console.log(`     ${l.slice(0, 220)}`));
    }
    const errors = log.filter((l) => /error|failed|refusing|couldn't/i.test(l)).slice(-3);
    if (errors.length) {
      console.log('   recent errors in data/agent.log:');
      errors.forEach((l) => console.log(`     ${l.slice(0, 200)}`));
    }
  }

  if (fs.existsSync(path.join(DATA_DIR, 'last-error.png'))) {
    console.log('   a screenshot of the last error is on the dashboard: Activity → "What the browser saw"');
  }
  console.log(`   browser identifies as: ${userAgent().replace(/^Mozilla\/5\.0 /, '')}`);

  const fails = results.filter((r) => r === 'fail').length;
  const warns = results.filter((r) => r === 'warn').length;
  console.log(`\n${fails ? `❌ ${fails} problem(s) to fix` : warns ? `⚠️  Working, ${warns} thing(s) to finish` : '✅ Everything looks good'}`);
}

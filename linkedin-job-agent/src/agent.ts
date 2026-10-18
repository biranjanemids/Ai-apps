import type { BrowserContext, Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, env, loadAnswers, loadSettings, type Settings } from './config.js';
import { fixTitle, exclusionReason, isBangalore, normalizeCompany, scoreJob, titleExcluded, type JobDetails } from './matching.js';
import {
  currentEmployers, loadProfile, mergeResume, profileFromResume, profileTitles, readResumeText, roleFromResume, saveProfile, yearsFromResume, type Profile,
} from './profile.js';
import { store, type JobRecord } from './store.js';
import { isLoggedIn, openBrowser, pause } from './linkedin/browser.js';
import { scrapeOwnProfile } from './linkedin/profile.js';
import { jobDetails, searchJobIds } from './linkedin/jobs.js';
import { easyApply, type ApplyResult } from './linkedin/easyApply.js';
import { externalApply } from './linkedin/externalApply.js';
import { splitName, type Applicant } from './answers.js';
import { aiAnswer, aiCoverNote, aiEnabled, aiFit, aiKeywords } from './ai.js';
import type { QuestionContext } from './answers.js';
import { notify, progress } from './notify.js';

/** Bump when scoring changes so jobs skipped as "low match" are scored again. */
const SCORING_VERSION = 2;

/** Present while a run is in progress; if the app is killed it stays, and the run resumes on restart. */
export const RUN_STATE = path.join(DATA_DIR, 'run-state.json');
const LAST_RUN = path.join(DATA_DIR, 'last-run.json');

export function lastRunEndedAt(): number {
  try {
    return Date.parse(JSON.parse(fs.readFileSync(LAST_RUN, 'utf8')).at) || 0;
  } catch {
    return 0;
  }
}

export const LAST_ERROR_SHOT = path.join(DATA_DIR, 'last-error.png');

/** The whole browser died (not just a tab): the run restarts it rather than failing every job. */
class BrowserGone extends Error {}
const isCrash = (e: unknown) => /crash|closed|detached|disconnected|Target/i.test((e as Error)?.message ?? '');

export interface LogLine {
  at: string;
  msg: string;
}

/** Every company the agent must never apply to: your list + employer(s) from your profile. */
export function effectiveExclusions(settings: Settings, profile: Profile | null): string[] {
  const all = [...settings.excludedCompanies, ...(settings.autoExcludeCurrentEmployer ? currentEmployers(profile) : [])];
  const seen = new Set<string>();
  return all.filter((c) => {
    const k = normalizeCompany(c);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function searchKeywords(settings: Settings, profile: Profile): string[] {
  if (settings.keywords.length) return settings.keywords;
  const current = profile.experiences.filter((e) => e.current).map((e) => e.title);
  const seen = new Set<string>();
  return [...current, ...profileTitles(profile)]
    .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
    .slice(0, 3);
}

class Agent {
  running = false;
  private stopRequested = false;
  logs: LogLine[] = [];
  lastRun: { at: string; summary: string } | null = null;

  log(msg: string) {
    const line = { at: new Date().toISOString(), msg };
    this.logs.push(line);
    if (this.logs.length > 300) this.logs.shift();
    console.log(`[${line.at.slice(11, 19)}] ${msg}`);
  }

  stop() {
    if (this.running) {
      this.stopRequested = true;
      this.log('Stop requested from the dashboard — finishing current job…');
    }
  }

  private async withPage<T>(fn: (page: Page, ctx: BrowserContext) => Promise<T>): Promise<T> {
    const ctx = await openBrowser({ lite: true });
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      if (!(await isLoggedIn(page))) {
        throw new Error('Not logged in to LinkedIn. Tap "Connect LinkedIn" on the dashboard (or run `npm run login` on a computer).');
      }
      return await fn(page, ctx);
    } catch (e) {
      // Save what the browser was showing so the problem can be seen from the dashboard
      const page = ctx.pages()[0];
      if (page) {
        await page.screenshot({ path: LAST_ERROR_SHOT, fullPage: false }).catch(() => {});
        this.log(`Browser was at: ${page.url().split('?')[0]} — screenshot saved (Activity → "What the browser saw")`);
      }
      throw e;
    } finally {
      await ctx.close();
    }
  }

  syncing = false;

  get busy() {
    return this.running || this.syncing;
  }

  async syncProfile(): Promise<Profile> {
    this.log('Reading your LinkedIn profile…');
    const wasSyncing = this.syncing;
    this.syncing = true;
    const scraped = await this.withPage((page) => scrapeOwnProfile(page)).finally(() => (this.syncing = wasSyncing));
    const resume = await readResumeText();
    const profile = mergeResume({ ...scraped, resumeText: '' }, resume);
    if (!scraped.experiences.length) {
      this.log("Couldn't read your work history from LinkedIn — make sure your company is listed under \"Never apply to\".");
    }
    if (!profile.totalYears) profile.totalYears = yearsFromResume(resume);
    if (!profile.headline) profile.headline = roleFromResume(resume);
    saveProfile(profile);
    this.log(
      `Profile: ${profile.name} — ${profile.headline}; ${profile.totalYears} yrs; ${profile.skills.length} skills; ` +
        `current employer: ${currentEmployers(profile).join(', ') || 'none detected'}`,
    );
    return profile;
  }

  /** Re-read the resume (e.g. after uploading a new one) without opening LinkedIn. */
  async refreshResume(): Promise<void> {
    const text = await readResumeText().catch((e: Error) => {
      this.log(`Couldn't read the resume: ${e.message}`);
      throw new Error(`Couldn't read the resume: ${e.message}`);
    });
    if (!text.trim()) {
      this.log('Resume has no readable text (is it a scanned image?). Upload a text-based PDF or a .txt file.');
      throw new Error('No readable text in the resume — upload a text-based PDF or a .txt file');
    }
    const p = loadProfile();
    // No LinkedIn yet: the resume alone is enough to search and score jobs
    const next = p ? mergeResume(p, text) : profileFromResume(text);
    if (p && !next.totalYears) next.totalYears = yearsFromResume(text);
    if (!next.headline) next.headline = roleFromResume(text);
    saveProfile(next);
    this.log(`Resume loaded: ${next.skills.length} skills, ${next.totalYears} yrs experience${next.headline ? `, role: ${next.headline}` : ''}`);
  }

  async run(): Promise<string> {
    if (this.running) return 'Already running';
    this.running = true;
    this.stopRequested = false;
    // Count resumes so a run that keeps getting killed doesn't loop forever
    let attempts = 1;
    try {
      attempts = (JSON.parse(fs.readFileSync(RUN_STATE, 'utf8')).attempts ?? 0) + 1;
    } catch {
      // fresh run
    }
    fs.writeFileSync(RUN_STATE, JSON.stringify({ startedAt: new Date().toISOString(), attempts }));
    progress('Starting…');
    try {
      // On a phone, Android sometimes kills the browser mid-run. Finished jobs and the queue are
      // saved, so start a fresh browser and carry on (up to twice).
      for (let attempt = 1; ; attempt++) {
        try {
          return await this.runInner();
        } catch (e) {
          if (!(e instanceof BrowserGone || isCrash(e)) || this.stopRequested || attempt > 2) throw e;
          this.log(`${(e as Error).message} — restarting the browser and continuing (${attempt}/2)…`);
          await pause(5000, 8000);
        }
      }
    } catch (e) {
      const msg = `Run failed: ${(e as Error).message}`;
      this.log(msg);
      await notify('LinkedIn agent error', msg);
      return msg;
    } finally {
      this.running = false;
      fs.rmSync(RUN_STATE, { force: true });
      fs.writeFileSync(LAST_RUN, JSON.stringify({ at: new Date().toISOString() }));
      progress(null);
    }
  }

  private async runInner(): Promise<string> {
    const settings = loadSettings();
    // A resume-only profile doesn't know your current employer — always read LinkedIn first
    const saved = loadProfile();
    const profile = saved?.profileUrl ? saved : await this.syncProfile();
    const years = settings.yearsExperience ?? profile.totalYears;
    const exclusions = effectiveExclusions(settings, profile);

    if (!exclusions.length && !settings.dryRun) {
      throw new Error(
        'Refusing to apply: no excluded companies. Add your employer (and parent company) in Settings, ' +
          'or re-sync your profile so the current employer is detected.',
      );
    }
    const budget = Math.min(settings.maxPerRun, env.maxPerDay - store.appliedToday());
    if (budget <= 0 && !settings.dryRun) return 'Daily application limit reached';

    let keywords = searchKeywords(settings, profile);
    if (!settings.keywords.length && aiEnabled()) {
      // AI suggests extra job titles from your resume (you can override them in Settings)
      const extra = await aiKeywords(profile, years);
      const seenKw = new Set(keywords.map((k) => k.toLowerCase()));
      keywords = [...keywords, ...extra.filter((k) => !seenKw.has(k.toLowerCase()))].slice(0, 4);
      if (extra.length) this.log(`AI suggested search titles: ${extra.join(', ')}`);
    }
    keywords = keywords.map(fixTitle);
    this.log(`Run started (${settings.dryRun ? 'DRY RUN' : 'LIVE'}). Keywords: ${keywords.join(' / ')}. Never applying to: ${exclusions.join(', ') || '—'}`);
    const answers = loadAnswers();
    const qctx = { answers, skills: profile.skills, years, profileUrl: profile.profileUrl };
    const me = { titles: [...keywords, ...profileTitles(profile)], skills: profile.skills, years };

    const current = profile.experiences.find((e) => e.current);
    const applicant: Applicant = {
      ...splitName(profile.name),
      fullName: profile.name,
      email: answers.email,
      phone: answers.phone,
      linkedinUrl: answers.linkedinUrl ?? (profile.profileUrl || undefined),
      portfolioUrl: answers.portfolioUrl,
      city: answers.city ?? 'Bengaluru',
      currentCompany: current?.company,
      currentTitle: current?.title,
    };

    return this.withPage(async (firstPage, ctx) => {
      // On a phone LinkedIn tabs slowly eat memory and can crash. Recycle the tab every few
      // jobs, and if it crashes open a fresh one and carry on.
      let page = firstPage;
      let uses = 0;
      const freshTab = async () => {
        await page.close().catch(() => {});
        page = await ctx.newPage();
        uses = 0;
      };
      const onPage = async <T>(fn: (p: Page) => Promise<T>): Promise<T> => {
        if (++uses > 8) await freshTab();
        try {
          return await fn(page);
        } catch (e) {
          if (!isCrash(e)) throw e;
          this.log('Browser tab crashed (low memory) — opening a fresh tab and continuing');
          try {
            await freshTab();
          } catch {
            throw new BrowserGone('the browser closed (Android may have killed it)');
          }
          try {
            return await fn(page);
          } catch (e2) {
            if (isCrash(e2)) throw new BrowserGone('the browser keeps crashing');
            throw e2;
          }
        }
      };

      let applied = 0;
      let attention = 0;
      let tried = 0;
      const limit = settings.dryRun ? Math.max(settings.maxPerRun, 1) : budget;

      /** Apply to queued jobs, best score first, until the run's limit. */
      const applyQueue = async () => {
        const queue = store.list('queued').sort((a, b) => b.score - a.score);
        if (!queue.length || tried >= limit) return;
        this.log(`${queue.length} matches queued; applying to the top ${Math.min(limit - tried, queue.length)}`);
        for (const rec of queue) {
          if (this.stopRequested || tried >= limit) break;
          const job: JobDetails = {
            id: rec.id, url: rec.url, title: rec.title, company: rec.company, location: rec.location,
            description: rec.job?.description ?? '', easyApply: rec.job?.easyApply ?? false,
            externalApply: rec.job?.externalApply ?? true, externalUrl: rec.job?.externalUrl, alreadyApplied: false,
          };
          tried++;
          progress(`Applying ${tried}/${Math.min(limit, queue.length)}: ${job.title} @ ${job.company}`);
          this.log(`Applying (${tried}/${limit}): ${job.title} @ ${job.company} — ${job.easyApply ? 'Easy Apply' : 'company website'}`);
          // Belt and braces: re-check exclusion right before submitting.
          const ex = exclusionReason(job, exclusions);
          if (ex) {
            this.save(job, rec.score, rec.reasons, 'excluded', ex);
            continue;
          }
          const aiCtx = { profile, years, job };
          const jobQctx: QuestionContext = {
            ...qctx,
            ai: aiEnabled() ? (q, kind, options) => aiAnswer(q, kind, options, aiCtx) : undefined,
            coverNote: aiEnabled() ? () => aiCoverNote(aiCtx) : undefined,
            aiLog: [],
          };
          const res: ApplyResult = await onPage(async (p) => {
            await p.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await pause(1500, 2500);
            const r = await (job.easyApply
              ? easyApply(p, jobQctx, settings.dryRun)
              : externalApply(p, ctx, applicant, jobQctx, settings.dryRun, job.externalUrl));
            // The form "failed" only because the browser died under it — retry, don't give up
            if (r.status === 'failed' && p.isClosed()) throw new Error('Target page closed during apply');
            return r;
          }).catch((e) => {
            if (e instanceof BrowserGone) throw e; // job stays queued; run() restarts the browser
            return { status: 'failed' as const, note: (e as Error).message.split('\n')[0] };
          });
          if (jobQctx.aiLog?.length) this.log(`AI wrote ${jobQctx.aiLog.length} answer(s): ${jobQctx.aiLog.map((x) => x.q).join(' | ').slice(0, 150)}`);
          this.save(job, rec.score, rec.reasons, res.status, res.note, res.applyUrl, jobQctx.aiLog);
          if (res.status === 'applied') applied++;
          if (res.status === 'needs_attention') attention++;
          await pause(20000, 45000);
        }
      };

      // 0. Matches left over from a run that crashed or was stopped go first
      await applyQueue();

      // 1. Find and score; good matches are queued (saved) immediately
      const seen = new Set<string>();
      const tally: Record<string, number> = {};
      let found = 0;
      let matches = 0;
      for (const kw of keywords) {
        if (this.stopRequested) break;
        const { ids, source } = await onPage((p) => searchJobIds(p, kw, settings, env.maxJobsScannedPerKeyword));
        found += ids.length;
        const kind = settings.applyMode === 'easy' ? 'Easy Apply jobs' : 'jobs';
        this.log(`"${kw}": ${ids.length} ${kind} in ${env.location} (from ${source})`);
        if (!ids.length) {
          await page.screenshot({ path: LAST_ERROR_SHOT }).catch(() => {});
          this.log(`No results for "${kw}" — screenshot saved (Activity → "What the browser saw")`);
        }
        let i = 0;
        for (const id of ids) {
          if (this.stopRequested) break;
          i++;
          const prev = store.get(id);
          // dry-run results are re-evaluated in live mode, and jobs skipped only for not being
          // Easy Apply are re-checked now that company sites are supported
          const retry =
            !prev ||
            prev.status === 'dry_run' ||
            (prev.status === 'skipped' && /easy apply|external site/i.test(prev.note ?? '')) ||
            (prev.status === 'skipped' && /^match/.test(prev.note ?? '') && (prev.v ?? 1) < SCORING_VERSION) ||
            (prev.status === 'failed' && /couldn't open the job page|crash|closed|Target/i.test(prev.note ?? ''));
          if (seen.has(id) || !retry) {
            tally['seen before'] = (tally['seen before'] ?? 0) + 1;
            continue;
          }
          seen.add(id);
          progress(`Checking "${kw}" jobs: ${i}/${ids.length} · ${matches} matches so far`);
          const job = await onPage((p) => jobDetails(p, id)).catch((e: Error) => {
            if (e instanceof BrowserGone) throw e;
            this.log(`Couldn't open job ${id}: ${e.message.split('\n')[0]}`);
            return null;
          });
          if (!job || !job.title) {
            tally['unreadable'] = (tally['unreadable'] ?? 0) + 1;
            if (job) this.log(`Couldn't read job ${id} (no title on the page)`);
            continue;
          }
          const verdict = await this.evaluate(job, settings, exclusions, me, profile, years);
          if (verdict.status) {
            this.save(job, verdict.score, verdict.reasons, verdict.status, verdict.note);
            const note = verdict.note ?? '';
            const why =
              verdict.status === 'excluded' ? 'your company (blocked)'
              : /^match/.test(note) ? 'below your match score'
              : /^location/.test(note) ? 'outside Bengaluru'
              : note.replace(/\d+/g, 'N');
            tally[why] = (tally[why] ?? 0) + 1;
          } else {
            matches++;
            this.save(job, verdict.score, verdict.reasons, 'queued', 'waiting to apply');
            this.log(`MATCH ${verdict.score}%: ${job.title} @ ${job.company} (${i}/${ids.length}) — queued`);
          }
          await pause(1500, 3500);
        }
      }
      if (this.stopRequested) this.log('Search stopped early from the dashboard.');
      const breakdown = Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ');
      this.log(`Checked ${found} jobs → ${matches} good matches${breakdown ? `; skipped: ${breakdown}` : ''}`);

      // 2. Apply to the queue, best matches first
      await applyQueue();

      const left = store.list('queued').length;
      const stopped = this.stopRequested ? ' (stopped early from the dashboard)' : '';
      const rest = left ? ` ${left} more queued for the next run.` : '';
      const summary = settings.dryRun
        ? `Dry run done: ${matches} new matches, forms checked for ${tried}${stopped}.${rest}`
        : `Applied to ${applied} jobs in ${env.location}. ${attention} need your input${stopped}.${rest}`;
      this.lastRun = { at: new Date().toISOString(), summary };
      this.log(summary);
      await notify('LinkedIn job agent', summary);
      return summary;
    });
  }

  private async evaluate(
    job: JobDetails,
    settings: Settings,
    exclusions: string[],
    me: { titles: string[]; skills: string[]; years: number },
    profile: Profile,
    years: number,
  ): Promise<{ status?: JobRecord['status']; note?: string; score: number; reasons: string[] }> {
    const ex = exclusionReason(job, exclusions);
    if (ex) return { status: 'excluded', note: ex, score: 0, reasons: [] };
    if (job.alreadyApplied) return { status: 'skipped', note: 'already applied on LinkedIn', score: 0, reasons: [] };
    if (!job.easyApply && !job.externalApply) return { status: 'skipped', note: 'no Apply button (closed or already applied)', score: 0, reasons: [] };
    if (!job.easyApply && settings.applyMode === 'easy') return { status: 'skipped', note: 'company-site job (Easy Apply only is on)', score: 0, reasons: [] };
    if (!isBangalore(job.location)) return { status: 'skipped', note: `location: ${job.location}`, score: 0, reasons: [] };
    const t = titleExcluded(job.title, settings.excludedTitleWords);
    if (t) return { status: 'skipped', note: t, score: 0, reasons: [] };

    let { score, reasons } = scoreJob(job, me);
    const llm = await aiFit(job, profile, years);
    if (llm) {
      score = Math.round((score + llm.score) / 2);
      reasons = [...reasons, `AI: ${llm.score} — ${llm.why}`];
    }
    if (score < settings.minScore) return { status: 'skipped', note: `match ${score} < ${settings.minScore}`, score, reasons };
    return { score, reasons };
  }

  private save(
    job: JobDetails, score: number, reasons: string[], status: JobRecord['status'], note?: string, applyUrl?: string, aiAnswers?: { q: string; a: string }[],
  ) {
    store.save({
      id: job.id, title: job.title, company: job.company, location: job.location, url: job.url, score, reasons, status, note, applyUrl,
      aiAnswers: aiAnswers?.length ? aiAnswers : undefined, v: SCORING_VERSION, at: new Date().toISOString(),
      job: status === 'queued'
        ? { easyApply: job.easyApply, externalApply: job.externalApply, externalUrl: job.externalUrl, description: job.description.slice(0, 6000) }
        : undefined,
    });
    this.log(`${status.toUpperCase()}: ${job.title} @ ${job.company} (${score})${note ? ` — ${note}` : ''}`);
  }
}

export const agent = new Agent();

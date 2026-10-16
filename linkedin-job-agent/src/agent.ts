import type { BrowserContext, Page } from 'playwright';
import path from 'node:path';
import { DATA_DIR, env, loadAnswers, loadSettings, type Settings } from './config.js';
import { exclusionReason, isBangalore, normalizeCompany, scoreJob, titleExcluded, type JobDetails } from './matching.js';
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
import { llmFit } from './llm.js';
import { notify } from './notify.js';

export const LAST_ERROR_SHOT = path.join(DATA_DIR, 'last-error.png');

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
      this.log('Stop requested — finishing current job…');
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
    try {
      try {
        return await this.runInner();
      } catch (e) {
        // On a phone, Android sometimes kills the browser mid-run; finished jobs are saved,
        // so start a fresh browser and carry on once
        if (!/has been closed|crashed|disconnected/i.test((e as Error).message) || this.stopRequested) throw e;
        this.log('The browser closed unexpectedly (low memory?) — restarting it and continuing…');
        return await this.runInner();
      }
    } catch (e) {
      const msg = `Run failed: ${(e as Error).message}`;
      this.log(msg);
      await notify('LinkedIn agent error', msg);
      return msg;
    } finally {
      this.running = false;
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

    const keywords = searchKeywords(settings, profile);
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

    return this.withPage(async (page, ctx) => {
      // 1. Find and rank
      const candidates: { job: JobDetails; score: number; reasons: string[] }[] = [];
      const seen = new Set<string>();
      const tally: Record<string, number> = {};
      let found = 0;
      for (const kw of keywords) {
        if (this.stopRequested) break;
        const { ids, source } = await searchJobIds(page, kw, settings, env.maxJobsScannedPerKeyword);
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
          const retry = !prev || prev.status === 'dry_run' || (prev.status === 'skipped' && /easy apply|external site/i.test(prev.note ?? ''));
          if (seen.has(id) || !retry) {
            tally['seen before'] = (tally['seen before'] ?? 0) + 1;
            continue;
          }
          seen.add(id);
          const job = await jobDetails(page, id).catch((e: Error) => {
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
            candidates.push({ job, score: verdict.score, reasons: verdict.reasons });
            this.log(`MATCH ${verdict.score}%: ${job.title} @ ${job.company} (${i}/${ids.length})`);
          }
          await pause(1500, 3500);
        }
      }
      const breakdown = Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ');
      this.log(`Checked ${found} jobs → ${candidates.length} good matches${breakdown ? `; skipped: ${breakdown}` : ''}`);

      // 2. Apply best matches first
      candidates.sort((a, b) => b.score - a.score);
      const limit = settings.dryRun ? Math.max(settings.maxPerRun, 1) : budget;
      this.log(`${candidates.length} jobs passed filters; applying to top ${Math.min(limit, candidates.length)}`);
      let applied = 0;
      let attention = 0;
      for (const c of candidates.slice(0, limit)) {
        if (this.stopRequested) break;
        // Belt and braces: re-check exclusion right before submitting.
        const ex = exclusionReason(c.job, exclusions);
        if (ex) {
          this.save(c.job, c.score, c.reasons, 'excluded', ex);
          continue;
        }
        await page.goto(c.job.url, { waitUntil: 'domcontentloaded' });
        await pause(1500, 2500);
        const res: ApplyResult = await (c.job.easyApply
          ? easyApply(page, qctx, settings.dryRun)
          : externalApply(page, ctx, applicant, qctx, settings.dryRun, c.job.externalUrl)
        ).catch((e) => ({ status: 'failed' as const, note: (e as Error).message.split('\n')[0] }));
        this.save(c.job, c.score, c.reasons, res.status, res.note, res.applyUrl);
        if (res.status === 'applied') applied++;
        if (res.status === 'needs_attention') attention++;
        await pause(20000, 45000);
      }

      const summary = settings.dryRun
        ? `Dry run done: ${candidates.length} matches found, forms checked for ${Math.min(limit, candidates.length)}.`
        : `Applied to ${applied} jobs in ${env.location}. ${attention} need your input.`;
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
    const llm = await llmFit(job, profile, years);
    if (llm) {
      score = Math.round((score + llm.score) / 2);
      reasons = [...reasons, `AI: ${llm.score} — ${llm.why}`];
    }
    if (score < settings.minScore) return { status: 'skipped', note: `match ${score} < ${settings.minScore}`, score, reasons };
    return { score, reasons };
  }

  private save(job: JobDetails, score: number, reasons: string[], status: JobRecord['status'], note?: string, applyUrl?: string) {
    store.save({ id: job.id, title: job.title, company: job.company, location: job.location, url: job.url, score, reasons, status, note, applyUrl, at: new Date().toISOString() });
    this.log(`${status.toUpperCase()}: ${job.title} @ ${job.company} (${score})${note ? ` — ${note}` : ''}`);
  }
}

export const agent = new Agent();

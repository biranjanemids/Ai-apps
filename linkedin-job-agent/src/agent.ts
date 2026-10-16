import type { BrowserContext, Page } from 'playwright';
import { env, loadAnswers, loadSettings, type Settings } from './config.js';
import { exclusionReason, isBangalore, normalizeCompany, scoreJob, titleExcluded, type JobDetails } from './matching.js';
import { currentEmployers, loadProfile, mergeResume, profileTitles, readResumeText, saveProfile, type Profile } from './profile.js';
import { store, type JobRecord } from './store.js';
import { isLoggedIn, openBrowser, pause } from './linkedin/browser.js';
import { scrapeOwnProfile } from './linkedin/profile.js';
import { jobDetails, searchJobIds } from './linkedin/jobs.js';
import { easyApply } from './linkedin/easyApply.js';
import { llmFit } from './llm.js';
import { notify } from './notify.js';

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
    const ctx = await openBrowser();
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      if (!(await isLoggedIn(page))) {
        throw new Error('Not logged in to LinkedIn. Run `npm run login` on the computer once (or set LINKEDIN_LI_AT).');
      }
      return await fn(page, ctx);
    } finally {
      await ctx.close();
    }
  }

  async syncProfile(): Promise<Profile> {
    this.log('Reading your LinkedIn profile…');
    const scraped = await this.withPage((page) => scrapeOwnProfile(page));
    const profile = mergeResume({ ...scraped, resumeText: '' }, await readResumeText());
    saveProfile(profile);
    this.log(
      `Profile: ${profile.name} — ${profile.headline}; ${profile.totalYears} yrs; ${profile.skills.length} skills; ` +
        `current employer: ${currentEmployers(profile).join(', ') || 'none detected'}`,
    );
    return profile;
  }

  async run(): Promise<string> {
    if (this.running) return 'Already running';
    this.running = true;
    this.stopRequested = false;
    try {
      return await this.runInner();
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
    const profile = loadProfile() ?? (await this.syncProfile());
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

    return this.withPage(async (page) => {
      // 1. Find and rank
      const candidates: { job: JobDetails; score: number; reasons: string[] }[] = [];
      const seen = new Set<string>();
      for (const kw of keywords) {
        if (this.stopRequested) break;
        const ids = await searchJobIds(page, kw, settings, env.maxJobsScannedPerKeyword);
        this.log(`"${kw}": ${ids.length} Easy Apply jobs in ${env.location}`);
        for (const id of ids) {
          if (this.stopRequested) break;
          // dry-run results are re-evaluated once you switch to live mode
          const prev = store.get(id);
          if (seen.has(id) || (prev && prev.status !== 'dry_run')) continue;
          seen.add(id);
          const job = await jobDetails(page, id).catch(() => null);
          if (!job || !job.title) continue;
          const verdict = await this.evaluate(job, settings, exclusions, me, profile, years);
          if (verdict.status) {
            this.save(job, verdict.score, verdict.reasons, verdict.status, verdict.note);
          } else {
            candidates.push({ job, score: verdict.score, reasons: verdict.reasons });
          }
          await pause(1500, 3500);
        }
      }

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
        const res = await easyApply(page, qctx, settings.dryRun).catch((e) => ({ status: 'failed' as const, note: (e as Error).message }));
        this.save(c.job, c.score, c.reasons, res.status, res.note);
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
    if (!job.easyApply) return { status: 'skipped', note: 'not Easy Apply (external site)', score: 0, reasons: [] };
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

  private save(job: JobDetails, score: number, reasons: string[], status: JobRecord['status'], note?: string) {
    store.save({ id: job.id, title: job.title, company: job.company, location: job.location, url: job.url, score, reasons, status, note, at: new Date().toISOString() });
    this.log(`${status.toUpperCase()}: ${job.title} @ ${job.company} (${score})${note ? ` — ${note}` : ''}`);
  }
}

export const agent = new Agent();

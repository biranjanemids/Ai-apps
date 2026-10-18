import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import { aiEnabled, aiHealth } from './ai.js';
import { DATA_DIR, VERSION, env, saveGroqKey, loadAnswers, loadSettings, saveAnswers, saveSettings, type Answers, type Settings } from './config.js';
import { agent, effectiveExclusions, LAST_ERROR_SHOT, lastRunEndedAt, RUN_STATE, searchKeywords } from './agent.js';
import { currentEmployers, loadProfile, yearsFromResume } from './profile.js';
import { extractSkillsFromText } from './matching.js';
import { store, type JobStatus } from './store.js';
import { plausibleLakhs } from './answers.js';
import { getSession } from './linkedin/browser.js';
import * as login from './linkedin/remoteLogin.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function auth(req: Request, res: Response, next: NextFunction) {
  const given = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given);
  const b = Buffer.from(env.dashboardToken);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

export function startServer() {
  if (env.dashboardToken.length < 16) {
    throw new Error('Set DASHBOARD_TOKEN in .env to a random string of 16+ characters (e.g. `openssl rand -hex 24`).');
  }
  const app = express();
  app.use(express.json());
  app.use(express.static(PUBLIC));
  app.use('/api', auth);

  app.get('/api/status', (_req, res) => {
    const settings = loadSettings();
    const profile = loadProfile();
    res.json({
      version: VERSION,
      running: agent.running,
      busy: agent.busy || login.loginActive(),
      linkedin: getSession(),
      resume: env.resumePath ? path.basename(env.resumePath) : null,
      ai: { configured: Boolean(env.groqApiKey), enabled: aiEnabled(), keywords: readAiKeywords() },
      nextRunAt: (() => {
        const h = loadSettings().autoRunHours;
        return h ? new Date(Math.max(Date.now(), lastRunEndedAt() + h * 3600_000)).toISOString() : null;
      })(),
      lastErrorShot: fs.existsSync(LAST_ERROR_SHOT) ? fs.statSync(LAST_ERROR_SHOT).mtime.toISOString() : null,
      lastRun: agent.lastRun,
      appliedToday: store.appliedToday(),
      maxPerDay: env.maxPerDay,
      counts: store.counts(),
      settings,
      exclusions: effectiveExclusions(settings, profile),
      detectedEmployers: currentEmployers(profile),
      keywords: profile ? searchKeywords(settings, profile) : settings.keywords,
      location: env.location,
      profile: profile && {
        name: profile.name,
        headline: profile.headline,
        years: settings.yearsExperience ?? profile.totalYears,
        skills: profile.skills,
        hasResume: Boolean(profile.resumeText),
        fromLinkedIn: Boolean(profile.profileUrl),
        resumeSkills: profile.resumeText ? extractSkillsFromText(profile.resumeText) : [],
        resumeYears: profile.resumeText ? yearsFromResume(profile.resumeText) : null,
        updatedAt: profile.updatedAt,
      },
      logs: agent.logs.slice(-60),
    });
  });

  app.get('/api/jobs/:id/shot', (req, res) => {
    const file = path.join(DATA_DIR, 'shots', `${String(req.params.id).replace(/\D/g, '')}.png`);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'no screenshot' });
    res.type('image/png').set('Cache-Control', 'no-store').send(fs.readFileSync(file));
  });

  app.get('/api/jobs', (req, res) => {
    const status = (req.query.status as JobStatus | undefined) || undefined;
    res.json(store.list(status).slice(0, 200));
  });

  app.post('/api/run', (_req, res) => {
    if (agent.busy || login.loginActive()) return res.status(409).json({ error: 'busy' });
    void agent.run();
    res.json({ ok: true });
  });

  // ── AI (Groq) ──
  app.post('/api/ai', async (req, res) => {
    const { key, useAI } = req.body as { key?: string; useAI?: boolean };
    if (typeof key === 'string' && key.trim()) {
      // Check the key works before saving it
      const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${key.trim()}` } }).catch(() => null);
      if (!r?.ok) return res.status(400).json({ error: r ? `Groq rejected the key (HTTP ${r.status})` : "Couldn't reach Groq" });
      saveGroqKey(key);
      agent.log('AI key saved — AI scoring, answers, keywords and cover notes are on');
    }
    if (typeof useAI === 'boolean') saveSettings({ useAI });
    res.json({ configured: Boolean(env.groqApiKey), enabled: aiEnabled() });
  });

  app.get('/api/ai/test', async (_req, res) => res.json(await aiHealth()));

  app.post('/api/jobs/recheck', (_req, res) => {
    if (agent.busy) return res.status(409).json({ error: 'busy' });
    const n = store.forgetUnapplied();
    agent.log(`Cleared ${n} skipped/failed/dry-run jobs — they'll be checked again on the next run`);
    res.json({ cleared: n });
  });

  app.post('/api/stop', (_req, res) => {
    agent.stop();
    res.json({ ok: true });
  });

  app.post('/api/sync-profile', (_req, res) => {
    if (agent.busy || login.loginActive()) return res.status(409).json({ error: 'busy' });
    agent.syncProfile().catch((e) => agent.log(`Profile sync failed: ${(e as Error).message}`));
    res.json({ ok: true });
  });

  app.post('/api/settings', (req, res) => {
    const b = req.body as Partial<Settings>;
    const patch: Partial<Settings> = {};
    const strings = (v: unknown) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : undefined);
    if (b.excludedCompanies) patch.excludedCompanies = strings(b.excludedCompanies);
    if (b.keywords) patch.keywords = strings(b.keywords);
    if (b.excludedTitleWords) patch.excludedTitleWords = strings(b.excludedTitleWords);
    if (typeof b.autoExcludeCurrentEmployer === 'boolean') patch.autoExcludeCurrentEmployer = b.autoExcludeCurrentEmployer;
    if (typeof b.dryRun === 'boolean') patch.dryRun = b.dryRun;
    if (Number.isFinite(b.minScore)) patch.minScore = Math.max(0, Math.min(100, Number(b.minScore)));
    if (Number.isFinite(b.maxPerRun)) patch.maxPerRun = Math.max(1, Math.min(50, Number(b.maxPerRun)));
    if (b.yearsExperience === null || Number.isFinite(b.yearsExperience)) patch.yearsExperience = b.yearsExperience ?? null;
    if (Number.isFinite(b.autoRunHours)) patch.autoRunHours = Math.max(0, Math.min(48, Number(b.autoRunHours)));
    if (b.applyMode === 'all' || b.applyMode === 'easy') patch.applyMode = b.applyMode;
    if (b.postedWithin && ['r86400', 'r604800', 'r2592000'].includes(b.postedWithin)) patch.postedWithin = b.postedWithin;
    res.json(saveSettings(patch));
  });

  // ── Log in to LinkedIn from the phone (remote screen) ──
  const wrap = (fn: (req: Request) => Promise<unknown>) => (req: Request, res: Response) =>
    fn(req).then((r) => res.json(r ?? { ok: true }), (e: Error) => res.status(400).json({ error: e.message }));
  app.post('/api/login/start', wrap(async () => {
    if (agent.busy) throw new Error('Agent is running — stop it first');
    await login.start();
  }));
  app.get('/api/login/screen', (_req, res) => {
    login.screenshot().then(
      (img) => res.type('image/jpeg').set('Cache-Control', 'no-store').send(img),
      (e: Error) => res.status(400).json({ error: e.message }),
    );
  });
  app.post('/api/login/tap', wrap((req) => login.tap(Number(req.body.x), Number(req.body.y))));
  app.post('/api/login/type', wrap((req) => login.type(String(req.body.text ?? ''))));
  app.post('/api/login/key', wrap((req) => login.press(String(req.body.key))));
  app.post('/api/login/scroll', wrap((req) => login.scroll(Number(req.body.dy) || 0)));
  app.post('/api/login/finish', wrap(async () => {
    const ok = await login.finish();
    if (ok && !loadProfile()?.profileUrl) agent.syncProfile().catch((e) => agent.log(`Profile sync failed: ${(e as Error).message}`));
    return { ok };
  }));
  app.post('/api/login/cancel', wrap(() => login.stop()));

  app.get('/api/debug/last-error.png', (_req, res) => {
    if (!fs.existsSync(LAST_ERROR_SHOT)) return res.status(404).json({ error: 'none' });
    res.type('image/png').set('Cache-Control', 'no-store').send(fs.readFileSync(LAST_ERROR_SHOT));
  });

  // ── Resume upload ──
  app.post('/api/resume', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) return res.status(400).json({ error: 'empty file' });
    const isPdf = body.subarray(0, 5).toString() === '%PDF-';
    for (const f of ['resume.pdf', 'resume.txt']) fs.rmSync(path.join(DATA_DIR, f), { force: true });
    fs.writeFileSync(path.join(DATA_DIR, isPdf ? 'resume.pdf' : 'resume.txt'), body);
    agent.refreshResume().then(() => res.json({ ok: true }), (e: Error) => res.status(400).json({ error: e.message }));
  });

  // ── Screening-question answers ──
  app.get('/api/answers', (_req, res) => res.json(loadAnswers()));
  app.post('/api/answers', (req, res) => {
    const b = req.body as Answers;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const n = (v: unknown) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? undefined : Number(v));
    const flag = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
    const next: Answers = {
      ...loadAnswers(),
      phone: str(b.phone), email: str(b.email), city: str(b.city), linkedinUrl: str(b.linkedinUrl), portfolioUrl: str(b.portfolioUrl),
      noticePeriodDays: n(b.noticePeriodDays), currentCtcLakhs: n(b.currentCtcLakhs), expectedCtcLakhs: n(b.expectedCtcLakhs),
      authorizedToWorkInIndia: flag(b.authorizedToWorkInIndia), requiresSponsorship: flag(b.requiresSponsorship),
      willingToRelocate: flag(b.willingToRelocate), comfortableOnsite: flag(b.comfortableOnsite),
    };
    for (const [k, label] of [['currentCtcLakhs', 'Current CTC'], ['expectedCtcLakhs', 'Expected CTC']] as const) {
      if (next[k] !== undefined && !plausibleLakhs(next[k])) {
        return res.status(400).json({ error: `${label} must be in lakhs per annum (e.g. 65 for ₹65 LPA), not ${next[k]}` });
      }
    }
    saveAnswers(next);
    res.json(next);
  });

  app.listen(env.port, env.host, () => {
    console.log(`Job agent ${VERSION} — dashboard: http://${env.host === '0.0.0.0' ? '<this-device-ip>' : env.host}:${env.port}/#token=${env.dashboardToken}`);
  });

  // Runs by itself: resume a run Android interrupted, and the "every N hours" schedule
  const interrupted = (() => {
    try {
      return JSON.parse(fs.readFileSync(RUN_STATE, 'utf8')) as { attempts?: number };
    } catch {
      return null;
    }
  })();
  if (interrupted && (interrupted.attempts ?? 1) >= 3) {
    agent.log('A run was interrupted 3 times in a row — not resuming automatically. Check the phone settings in the README, then tap Find.');
    fs.rmSync(RUN_STATE, { force: true });
  } else if (interrupted) {
    agent.log('A run was interrupted (the app was closed or killed) — resuming it in 15 seconds');
    setTimeout(() => {
      if (!agent.busy && !login.loginActive()) void agent.run();
    }, 15_000);
  }
  setInterval(() => {
    const hours = loadSettings().autoRunHours;
    if (!hours || agent.busy || login.loginActive()) return;
    if (Date.now() - lastRunEndedAt() >= hours * 3600_000) {
      agent.log(`Scheduled run (every ${hours} h)`);
      void agent.run();
    }
  }, 60_000);
}

function readAiKeywords(): string[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'ai-keywords.json'), 'utf8')).keywords ?? [];
  } catch {
    return [];
  }
}

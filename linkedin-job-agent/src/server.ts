import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { env, loadSettings, saveSettings, type Settings } from './config.js';
import { agent, effectiveExclusions, searchKeywords } from './agent.js';
import { currentEmployers, loadProfile } from './profile.js';
import { store, type JobStatus } from './store.js';

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
      running: agent.running,
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
        updatedAt: profile.updatedAt,
      },
      logs: agent.logs.slice(-60),
    });
  });

  app.get('/api/jobs', (req, res) => {
    const status = (req.query.status as JobStatus | undefined) || undefined;
    res.json(store.list(status).slice(0, 200));
  });

  app.post('/api/run', (_req, res) => {
    if (agent.running) return res.status(409).json({ error: 'already running' });
    void agent.run();
    res.json({ ok: true });
  });

  app.post('/api/stop', (_req, res) => {
    agent.stop();
    res.json({ ok: true });
  });

  app.post('/api/sync-profile', (_req, res) => {
    if (agent.running) return res.status(409).json({ error: 'agent is running' });
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
    if (b.postedWithin && ['r86400', 'r604800', 'r2592000'].includes(b.postedWithin)) patch.postedWithin = b.postedWithin;
    res.json(saveSettings(patch));
  });

  app.listen(env.port, '0.0.0.0', () => {
    console.log(`Dashboard on http://0.0.0.0:${env.port} — open it on your phone (same Wi-Fi, Tailscale or a tunnel).`);
  });

  if (env.runEveryMinutes > 0) {
    console.log(`Auto-run every ${env.runEveryMinutes} min`);
    setInterval(() => void agent.run(), env.runEveryMinutes * 60_000);
  }
}

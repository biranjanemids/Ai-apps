import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, env, loadSettings } from './config.js';
import type { FieldKind } from './answers.js';
import type { JobDetails } from './matching.js';
import type { Profile } from './profile.js';

/**
 * Optional AI helpers (Groq, free tier). Every prompt is grounded in your own resume and
 * LinkedIn profile, and told to answer null rather than invent anything. The AI never
 * decides whether to apply and never touches the company block list.
 */

type Chat = (system: string, user: string, maxTokens: number) => Promise<Record<string, unknown> | null>;

const API = 'https://api.groq.com/openai/v1';

/**
 * Groq retires models every few months, so don't hard-code one: ask which chat models this
 * key can use and take the best by preference (GROQ_MODEL in .env still overrides).
 */
const PREFERRED = [/gpt-oss-120b/i, /llama-4-maverick/i, /llama-3\.3-70b/i, /70b/i, /kimi/i, /qwen/i, /llama-4-scout/i, /gpt-oss-20b/i, /llama/i];
const NOT_CHAT = /whisper|guard|tts|playai|orpheus|embed|compound|distil|safeguard|allam/i;
let chosen: { id: string; at: number } | null = null;

export async function groqModel(refresh = false): Promise<string | null> {
  if (process.env.GROQ_MODEL) return process.env.GROQ_MODEL;
  if (!refresh && chosen && Date.now() - chosen.at < 6 * 3600_000) return chosen.id;
  const key = env.groqApiKey;
  if (!key) return null;
  try {
    const res = await fetch(`${API}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const { data } = (await res.json()) as { data: { id: string; active?: boolean }[] };
    const ids = data.filter((m) => m.active !== false && !NOT_CHAT.test(m.id)).map((m) => m.id);
    const id = PREFERRED.map((re) => ids.find((m) => re.test(m))).find(Boolean) ?? ids[0];
    if (!id) return null;
    chosen = { id, at: Date.now() };
    return id;
  } catch {
    return null;
  }
}

/** Models sometimes wrap JSON in prose or code fences. */
export function parseJsonLoose(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    try {
      return m ? JSON.parse(m[0]) : null;
    } catch {
      return null;
    }
  }
}

async function complete(model: string, messages: { role: string; content: string }[], maxTokens: number, json: boolean) {
  const reasoning = /gpt-oss|qwen3|deepseek/i.test(model);
  return fetch(`${API}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.groqApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      // reasoning models spend tokens thinking before they answer
      max_tokens: reasoning ? maxTokens + 1024 : maxTokens,
      ...(reasoning ? { reasoning_effort: 'low' } : {}),
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      messages,
    }),
    signal: AbortSignal.timeout(60000),
  });
}

const retired = (status: number, body: string) => status === 404 || /model_not_found|decommissioned|does not exist/i.test(body);

const groqChat: Chat = async (system, user, maxTokens) => {
  if (!env.groqApiKey) return null;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const model = await groqModel(attempt > 0);
      if (!model) return null;
      let res = await complete(model, messages, maxTokens, true);
      if (!res.ok) {
        const body = await res.text();
        if (retired(res.status, body)) continue; // pick another model and retry
        if (res.status === 400 && /response_format|json/i.test(body)) res = await complete(model, messages, maxTokens, false);
        if (!res.ok) return null;
      }
      const data = (await res.json()) as { choices: { message: { content: string } }[] };
      return parseJsonLoose(data.choices[0]?.message?.content ?? '');
    }
    return null;
  } catch {
    return null;
  }
};

let chat: Chat = groqChat;
/** Tests swap in a fake model. */
export const setChatForTests = (fn: Chat | null) => (chat = fn ?? groqChat);

export const aiEnabled = () => Boolean(env.groqApiKey) && loadSettings().useAI;

function candidateFacts(p: Profile, years: number): string {
  return [
    `Name: ${p.name}`,
    `Headline: ${p.headline}`,
    `Total experience: ${years} years`,
    `Roles: ${p.experiences.map((e) => `${e.title} at ${e.company} (${e.dates})`).join('; ') || 'see resume'}`,
    `Skills: ${p.skills.join(', ')}`,
    p.resumeText ? `Resume:\n${p.resumeText.slice(0, 7000)}` : '',
  ].join('\n');
}

const jobFacts = (j: Pick<JobDetails, 'title' | 'company' | 'description'>) =>
  `Job: ${j.title} at ${j.company}\n${j.description.slice(0, 3500)}`;

// ── 1. Fit score ─────────────────────────────────────────────────────────────

export async function aiFit(job: JobDetails, p: Profile, years: number): Promise<{ score: number; why: string } | null> {
  if (!aiEnabled()) return null;
  const out = await chat(
    'You are a strict technical recruiter. Rate 0-100 how well the candidate fits the job: skills, seniority and domain. ' +
      'A senior IC asked to be a people manager, or a very different tech stack, scores low. ' +
      'Reply as JSON: {"score": number, "why": "one short sentence"}',
    `CANDIDATE\n${candidateFacts(p, years)}\n\n${jobFacts(job)}`,
    150,
  );
  const score = Number(out?.score);
  return Number.isFinite(score) ? { score: Math.max(0, Math.min(100, score)), why: String(out?.why ?? '') } : null;
}

// ── 2. Screening questions the rules can't answer ────────────────────────────

/** Questions the AI must never answer: personal, legal, money or consent. */
const SENSITIVE =
  /gender|\bsex\b|race|ethnic|religio|caste|disab|veteran|criminal|convict|felony|salary|\bctc\b|compensation|\bpay\b|notice|sponsor|visa|authori[sz]|citizen|relocat|\bage\b|date of birth|\bdob\b|marital|pronoun|consent|agree|acknowledge|signature|background check|drug|reference|ssn|aadhaar|pan\b|passport/i;

const CACHE = path.join(DATA_DIR, 'ai-answers.json');
const readCache = (): Record<string, string | null> => {
  try {
    return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  } catch {
    return {};
  }
};

export interface AiAnswerContext {
  profile: Profile;
  years: number;
  job: Pick<JobDetails, 'title' | 'company' | 'description'>;
}

/** An answer drawn only from your resume/profile, or null if it can't be answered truthfully. */
export async function aiAnswer(question: string, kind: FieldKind, options: string[], ctx: AiAnswerContext): Promise<string | null> {
  const q = question.replace(/\s+/g, ' ').replace(/\*/g, '').trim();
  if (!q || SENSITIVE.test(q) || !aiEnabled()) return null;
  const long = kind === 'textarea';
  // Long answers are about this job; short factual ones are the same everywhere
  const key = `${kind}|${q.toLowerCase()}|${options.join('/')}${long ? `|${ctx.job.company}` : ''}`;
  const cache = readCache();
  if (key in cache) return cache[key];

  const out = await chat(
    'You fill in job application questions for a candidate. Use ONLY facts stated in the candidate profile and resume. ' +
      'Never invent employers, degrees, certifications, numbers, years or skills. ' +
      'If the facts do not support a truthful answer, return {"answer": null}. ' +
      (options.length ? 'The answer must be exactly one of the given options. ' : '') +
      (kind === 'number' ? 'Return a plain number. ' : '') +
      (long ? 'Write 60-120 words, first person, professional and specific to the job. ' : 'Keep it to one short phrase or sentence. ') +
      'Reply as JSON: {"answer": string | null}',
    `CANDIDATE\n${candidateFacts(ctx.profile, ctx.years)}\n\n${jobFacts(ctx.job)}\n\n` +
      `QUESTION: ${q}\nFIELD TYPE: ${kind}${options.length ? `\nOPTIONS: ${options.join(' | ')}` : ''}`,
    long ? 400 : 120,
  );
  let ans = typeof out?.answer === 'string' ? out.answer.trim() : null;
  if (ans && options.length && !options.includes(ans)) ans = options.find((o) => o.toLowerCase() === ans!.toLowerCase()) ?? null;
  if (ans && kind === 'number') ans = ans.match(/\d+(\.\d+)?/)?.[0] ?? null;
  if (ans && !long && ans.length > 200) ans = null;

  // Only cache successful calls (a null from a network error shouldn't stick)
  if (out) {
    cache[key] = ans;
    fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));
  }
  return ans;
}

// ── 3. Search keywords from your resume ──────────────────────────────────────

const KW_CACHE = path.join(DATA_DIR, 'ai-keywords.json');

/** 3-4 job titles worth searching for, based on your resume (cached for a week). */
export async function aiKeywords(p: Profile, years: number): Promise<string[]> {
  if (!aiEnabled()) return [];
  try {
    const c = JSON.parse(fs.readFileSync(KW_CACHE, 'utf8'));
    if (Date.now() - Date.parse(c.at) < 7 * 86400_000 && c.profileAt === p.updatedAt) return c.keywords;
  } catch {
    // no cache yet
  }
  const out = await chat(
    'Suggest 4 LinkedIn job-search titles this candidate is a strong fit for right now, at their current seniority. ' +
      'Use common job-title wording recruiters post (e.g. "Staff Software Engineer"), no company names. ' +
      'Reply as JSON: {"titles": [string]}',
    candidateFacts(p, years),
    120,
  );
  const titles = Array.isArray(out?.titles)
    ? (out!.titles as unknown[]).map(String).map((t) => t.trim()).filter((t) => t && t.length < 60).slice(0, 4)
    : [];
  if (titles.length) fs.writeFileSync(KW_CACHE, JSON.stringify({ at: new Date().toISOString(), profileAt: p.updatedAt, keywords: titles }));
  return titles;
}

// ── 4. Cover notes ───────────────────────────────────────────────────────────

/** A short cover note for this job, from your resume only. */
export async function aiCoverNote(ctx: AiAnswerContext): Promise<string | null> {
  if (!aiEnabled()) return null;
  const out = await chat(
    'Write a concise cover note (120-180 words) from the candidate to the hiring team. Use ONLY facts in the candidate ' +
      'profile and resume; do not invent achievements, numbers or skills. Mention 2-3 relevant strengths for this job. ' +
      'No greeting placeholders like [Name]; sign with the candidate name. Reply as JSON: {"note": string}',
    `CANDIDATE\n${candidateFacts(ctx.profile, ctx.years)}\n\n${jobFacts(ctx.job)}`,
    450,
  );
  const note = typeof out?.note === 'string' ? out.note.trim() : '';
  return note.length > 80 ? note : null;
}

// ── Health check ─────────────────────────────────────────────────────────────

export interface AiHealth {
  ok: boolean;
  detail: string;
  /** e.g. "13,950 of 14,400 requests left today" */
  limits?: string;
}

/** Sends a tiny real request to Groq to prove the key, model and network all work. */
export async function aiHealth(): Promise<AiHealth> {
  const key = env.groqApiKey;
  if (!key) return { ok: false, detail: 'no Groq key — add one on the dashboard (AI assistant card)' };
  if (!loadSettings().useAI) return { ok: false, detail: 'AI is switched off on the dashboard' };
  const started = Date.now();
  try {
    let model = await groqModel();
    if (!model) return { ok: false, detail: "couldn't list Groq models — check the key and internet" };
    const ask = (m: string) => complete(m, [{ role: 'user', content: 'Reply with the single word: ok' }], 5, false);
    let res = await ask(model);
    if (!res.ok && retired(res.status, await res.clone().text())) {
      model = await groqModel(true);
      if (!model) return { ok: false, detail: 'no usable Groq chat model found for this key' };
      res = await ask(model);
    }
    const n = (h: string) => Number(res.headers.get(h) ?? NaN);
    const reqLeft = n('x-ratelimit-remaining-requests');
    const reqMax = n('x-ratelimit-limit-requests');
    const limits = Number.isFinite(reqLeft) && Number.isFinite(reqMax) ? `${reqLeft.toLocaleString()} of ${reqMax.toLocaleString()} requests left today` : undefined;
    if (res.status === 401) return { ok: false, detail: 'Groq rejected the key — create a new one at console.groq.com/keys' };
    if (res.status === 429) return { ok: false, detail: "free limit reached for now — the agent uses rules until it resets", limits };
    if (!res.ok) return { ok: false, detail: `Groq answered HTTP ${res.status} (${(await res.text()).slice(0, 80)})`, limits };
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const reply = data.choices?.[0]?.message?.content?.trim() ?? '';
    return { ok: true, detail: `${model} answered "${reply.slice(0, 20)}" in ${((Date.now() - started) / 1000).toFixed(1)}s`, limits };
  } catch (e) {
    return { ok: false, detail: `can't reach api.groq.com (${(e as Error).message})` };
  }
}

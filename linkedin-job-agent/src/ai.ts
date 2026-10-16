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

const groqChat: Chat = async (system, user, maxTokens) => {
  const key = env.groqApiKey;
  if (!key) return null;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.groqModel,
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return JSON.parse(data.choices[0].message.content);
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

import { loadSettings } from './config.js';
import type { Answers } from './config.js';
import { mentions } from './matching.js';

export interface QuestionContext {
  answers: Answers;
  skills: string[];
  years: number;
  profileUrl: string;
  /** AI fallback for questions the rules can't answer (grounded in your resume) */
  ai?: (question: string, kind: FieldKind, options: string[]) => Promise<string | null>;
  /** AI cover note for this job */
  coverNote?: () => Promise<string | null>;
  /** What the AI wrote, so you can review it on the dashboard */
  aiLog?: { q: string; a: string }[];
}

/** Rules first (your saved answers); then the AI, if enabled; null if neither knows. */
export async function answerQuestion(question: string, kind: FieldKind, options: string[], ctx: QuestionContext): Promise<string | null> {
  const ruled = resolveAnswer(question, kind, options, ctx) ?? (loadSettings().autopilot ? autopilotDefault(question, kind, options) : null);
  if (ruled !== null || !ctx.ai) return ruled;
  const real = options.filter((o) => !/^select an option$|^please select/i.test(o.trim()));
  const raw = await ctx.ai(question, kind, real).catch(() => null);
  const ans = raw === null ? null : fitToOptions(raw, kind, real);
  if (ans !== null) ctx.aiLog?.push({ q: question.replace(/\s+/g, ' ').trim(), a: ans });
  return ans;
}

/**
 * Autopilot answers for questions that are about willingness or acknowledgement rather than
 * facts ("I agree…", "Are you willing to undergo a background check?") — the answer you'd give
 * by applying at all.
 */
export function autopilotDefault(question: string, kind: FieldKind, options: string[]): string | null {
  const q = question.toLowerCase();
  if (!/agree|acknowledge|consent|i understand|confirm that|certify|declare|background (check|verification)|drug (test|screen)|willing to (undergo|take|attend|work)|open to/.test(q)) return null;
  if (/criminal|convict|felony|charged/.test(q)) return null; // a legal fact, not willingness
  if (!options.length) return kind === 'number' ? null : 'Yes';
  return options.find((o) => /^(yes|i agree|agree|i accept|accept|i acknowledge|acknowledged?|i understand|i confirm|confirm)\b/i.test(o.trim())) ?? null;
}

export type FieldKind = 'text' | 'number' | 'select' | 'radio' | 'checkbox' | 'textarea';

const yes = (b: boolean | undefined, d: boolean) => ((b ?? d) ? 'Yes' : 'No');

/**
 * Picks a truthful answer for an Easy Apply screening question from your profile and
 * answers.json. Returns null when it doesn't know — the agent then leaves the job for
 * you to finish by hand instead of guessing.
 */
export function resolveAnswer(question: string, kind: FieldKind, options: string[], ctx: QuestionContext): string | null {
  const q = question.toLowerCase().replace(/\s+/g, ' ').trim();
  const a = ctx.answers;

  if (/gender|\bsex\b|race|ethnic|veteran|disabilit|sexual orientation|pronoun/.test(q) && options.length) {
    const decline = options.find((o) => /decline|not (wish|want) to|prefer not|rather not|don't wish|do not wish/i.test(o));
    if (decline) return decline;
  }
  const raw = (() => {
    for (const rule of a.custom ?? []) {
      try {
        if (new RegExp(rule.match, 'i').test(q)) return rule.answer;
      } catch {
        if (q.includes(rule.match.toLowerCase())) return rule.answer;
      }
    }
    if (/(mobile|phone).*(number)?/.test(q) && !/country code/.test(q)) return a.phone ?? null;
    if (/country code/.test(q)) return 'India (+91)';
    if (/e-?mail/.test(q)) return a.email ?? null;
    if (/linkedin/.test(q) && /(url|profile|link)/.test(q)) return a.linkedinUrl ?? ctx.profileUrl ?? null;
    if (/(portfolio|website|github)/.test(q)) return a.portfolioUrl ?? null;
    if (/notice period/.test(q)) {
      if (a.noticePeriodDays === undefined) return null;
      if (kind === 'number' || /days/.test(q)) return String(a.noticePeriodDays);
      if (/months?/.test(q)) return String(Math.ceil(a.noticePeriodDays / 30));
      return `${a.noticePeriodDays} days`;
    }
    if (/(expected|desired).*(ctc|salary|compensation)/.test(q)) return lakhs(a.expectedCtcLakhs, q);
    if (/(current|present).*(ctc|salary|compensation)/.test(q)) return lakhs(a.currentCtcLakhs, q);
    if (/(sponsor|visa)/.test(q)) return yes(a.requiresSponsorship, false);
    if (/(authori[sz]ed|eligible|legally).*(work)/.test(q)) return yes(a.authorizedToWorkInIndia, true);
    if (/relocat/.test(q)) return yes(a.willingToRelocate, true);
    if (/(commut|on-?site|hybrid|work(ing)? from (the )?office|in-office|wfo)/.test(q)) return yes(a.comfortableOnsite, true);
    if (/(city|current location|where are you (based|located))/.test(q)) return a.city ?? 'Bengaluru';
    if (/(background check|drug test|agree|consent|acknowledge|terms)/.test(q)) return 'Yes';

    // "How many years of experience do you have with <skill>?"
    if (/(years|yrs).*(experience|exp)|experience.*(years|yrs)/.test(q)) {
      const total = /(total|overall|professional|work) experience|years of experience\??$/.test(q);
      const skill = ctx.skills.find((s) => mentions(q, s));
      if (skill || total) return String(Math.floor(ctx.years));
      return null; // a skill you don't list — don't invent experience
    }
    // "Do you have experience with <skill>?" / "Are you proficient in <skill>?"
    if (/^(do|have|are|is) you|experience (with|in)|proficien|familiar|worked (on|with)/.test(q)) {
      if (ctx.skills.some((s) => mentions(q, s))) return 'Yes';
      return null;
    }
    return null;
  })();

  if (raw === null) return null;
  return fitToOptions(raw, kind, options);
}

/** A CTC in lakhs per annum that's actually plausible (catches typos like a PIN code). */
export const plausibleLakhs = (v: number | undefined) => v !== undefined && Number.isFinite(v) && v > 0 && v <= 500;

function lakhs(v: number | undefined, q: string): string | null {
  if (!plausibleLakhs(v)) return null; // leave it for you rather than submit a wrong figure
  if (v === undefined) return null;
  if (/lpa|lakh|lac/.test(q)) return String(v);
  if (/(inr|rupees|₹|annual|per annum)/.test(q)) return String(Math.round(v * 100000));
  return String(v);
}

/** Map an answer onto a select/radio option list (e.g. "Yes" → "Yes, I am"). */
export function fitToOptions(answer: string, kind: FieldKind, options: string[]): string | null {
  if (kind === 'number') {
    const n = answer.match(/\d+(\.\d+)?/);
    return n ? n[0] : null;
  }
  if ((kind !== 'select' && kind !== 'radio') || !options.length) return answer;
  const real = options.filter((o) => !/^select an option$/i.test(o.trim()));
  const a = answer.toLowerCase();
  return (
    real.find((o) => o.toLowerCase() === a) ??
    real.find((o) => o.toLowerCase().startsWith(a)) ??
    real.find((o) => o.toLowerCase().includes(a)) ??
    numericOption(answer, real) ??
    null
  );
}

/** "4" against ["0-2 years", "3-5 years", "5+ years"] → "3-5 years". */
function numericOption(answer: string, options: string[]): string | null {
  const n = Number(answer);
  if (!Number.isFinite(n)) return null;
  for (const o of options) {
    const m = o.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/);
    if (m && n >= Number(m[1]) && n <= Number(m[2])) return o;
    const plus = o.match(/(\d+)\s*\+/);
    if (plus && n >= Number(plus[1])) return o;
  }
  return null;
}

export interface Applicant {
  firstName: string;
  lastName: string;
  fullName: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  portfolioUrl?: string;
  city?: string;
  addressLine1?: string;
  postalCode?: string;
  state?: string;
  currentCompany?: string;
  currentTitle?: string;
}

/** Contact/identity fields found on company application forms (Greenhouse, Lever, …). */
export function identityAnswer(label: string, inputType: string, a: Applicant): string | null | undefined {
  const q = label.toLowerCase().replace(/\s+/g, ' ').replace(/\*/g, '').trim();
  if (inputType === 'email' || /e-?mail/.test(q)) return a.email ?? null;
  if (inputType === 'tel' || /\b(phone|mobile|contact number)\b/.test(q)) return a.phone ?? null;
  if (/first.?name|given name|forename/.test(q)) return a.firstName;
  if (/last.?name|surname|family name/.test(q)) return a.lastName || null;
  if (/^(full )?name$|^your name|full name|candidate name|legal name/.test(q)) return a.fullName;
  if (/linkedin/.test(q)) return a.linkedinUrl ?? null;
  if (/github|portfolio|website|personal (site|url)|other (url|link)/.test(q)) return a.portfolioUrl ?? null;
  if (/current (company|employer|organi[sz]ation)|^company$|^organi[sz]ation$/.test(q)) return a.currentCompany ?? null;
  if (/current (title|designation|role|position)/.test(q)) return a.currentTitle ?? null;
  if (/^(location|city|current location|current city|town)/.test(q)) return a.city ?? 'Bengaluru';
  if (/address( line)? ?1|street|^address$/.test(q)) return a.addressLine1 ?? null;
  if (/address( line)? ?2/.test(q)) return ''; // optional second line
  if (/postal|zip|pin ?code|^pin$|post ?code/.test(q)) return a.postalCode ?? null;
  if (/^(state|province|region)\b|state\/province/.test(q)) return a.state ?? 'Karnataka';
  if (/^country\b|country of residence/.test(q)) return 'India';
  if (/how did you (hear|learn|find)|source of (application|referral)|where did you (see|find)/.test(q)) return 'LinkedIn';
  return undefined; // not an identity field
}

export function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/).map((p) => p.charAt(0).toUpperCase() + p.slice(1));
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') };
}

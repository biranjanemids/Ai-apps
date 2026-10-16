import type { Answers } from './config.js';
import { mentions } from './matching.js';

export interface QuestionContext {
  answers: Answers;
  skills: string[];
  years: number;
  profileUrl: string;
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

function lakhs(v: number | undefined, q: string): string | null {
  if (v === undefined) return null;
  if (/lpa|lakh|lac/.test(q)) return String(v);
  if (/(inr|rupees|₹|annual|per annum)/.test(q)) return String(Math.round(v * 100000));
  return String(v);
}

/** Map an answer onto a select/radio option list (e.g. "Yes" → "Yes, I am"). */
function fitToOptions(answer: string, kind: FieldKind, options: string[]): string | null {
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

import { env } from './config.js';
import type { JobDetails } from './matching.js';
import type { Profile } from './profile.js';

/**
 * Optional second opinion from an LLM (Groq free tier) on how well the job fits your
 * resume. Returns null when no GROQ_API_KEY is set or the call fails.
 */
export async function llmFit(job: JobDetails, p: Profile, years: number): Promise<{ score: number; why: string } | null> {
  if (!env.groqApiKey) return null;
  const candidate = [
    `Headline: ${p.headline}`,
    `Experience: ${years} years`,
    `Roles: ${p.experiences.map((e) => `${e.title} @ ${e.company} (${e.dates})`).join('; ')}`,
    `Skills: ${p.skills.join(', ')}`,
    p.resumeText ? `Resume:\n${p.resumeText.slice(0, 5000)}` : '',
  ].join('\n');
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.groqApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.groqModel,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are a strict technical recruiter. Rate 0-100 how well the candidate fits the job (skills, seniority, domain). ' +
              'Reply as JSON: {"score": number, "why": "one short sentence"}',
          },
          { role: 'user', content: `CANDIDATE\n${candidate}\n\nJOB: ${job.title} at ${job.company}\n${job.description.slice(0, 6000)}` },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    const out = JSON.parse(data.choices[0].message.content);
    const score = Number(out.score);
    return Number.isFinite(score) ? { score: Math.max(0, Math.min(100, score)), why: String(out.why ?? '') } : null;
  } catch {
    return null;
  }
}

/**
 * Pure matching logic: employer exclusion, experience fit and job/profile scoring.
 * No browser or I/O here so it can be unit-tested.
 */

export interface JobDetails {
  id: string;
  title: string;
  company: string;
  location: string;
  description: string;
  url: string;
  easyApply: boolean;
  alreadyApplied: boolean;
}

export interface MatchInput {
  titles: string[];
  skills: string[];
  years: number;
}

// ── Company exclusion ────────────────────────────────────────────────────────

const LEGAL_SUFFIXES = new Set([
  'pvt', 'private', 'ltd', 'limited', 'inc', 'incorporated', 'llc', 'llp', 'plc', 'corp',
  'corporation', 'co', 'company', 'gmbh', 'ag', 'sa', 'the', 'india', 'pvtltd',
]);

export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !LEGAL_SUFFIXES.has(w))
    .join(' ');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const containsPhrase =(haystack: string, phrase: string) =>
  phrase.length > 0 && ` ${haystack} `.includes(` ${phrase} `);

/**
 * Returns a reason string when the job is at (or for) an excluded company, else null.
 * Deliberately conservative — a false "excluded" only costs one application, while a
 * false "allowed" would apply to your own employer.
 */
export function exclusionReason(
  job: Pick<JobDetails, 'company' | 'description'>,
  excluded: string[],
): string | null {
  const company = normalizeCompany(job.company);
  const desc = normalizeCompany(job.description);
  if (!company) return 'company name missing — not applying to an unknown employer';
  for (const raw of excluded) {
    const ex = normalizeCompany(raw);
    if (!ex) continue;
    if (company === ex || containsPhrase(company, ex) || containsPhrase(ex, company)) {
      return `employer "${job.company}" matches excluded "${raw}"`;
    }
    // Staffing agencies often write "our client, <Company>, is hiring…". Only flag the
    // name near hiring-on-behalf wording so "experience with Microsoft Azure" doesn't count.
    if (ex.length >= 4 && containsPhrase(desc, ex)) {
      const near = new RegExp(
        `(client|on behalf of|hiring for|payroll of|deployed at|work for|position with|role with|opportunity with)\\W+(?:\\w+\\W+){0,6}${escapeRe(ex)}\\b` +
          `|\\b${escapeRe(ex)}\\W+(?:\\w+\\W+){0,4}(is hiring|is looking|client)`,
      );
      if (near.test(desc)) return `description says the role is for excluded company "${raw}"`;
    }
  }
  return null;
}

// ── Experience ───────────────────────────────────────────────────────────────

/** Finds the experience requirement, e.g. "5+ years", "3-6 yrs", "minimum 4 years". */
export function requiredYears(text: string): { min: number; max: number | null } | null {
  const re = /(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*(\d{1,2})\s*)?\+?\s*(?:years?|yrs?)/gi;
  let best: { min: number; max: number | null } | null = null;
  for (const m of text.matchAll(re)) {
    const min = Number(m[1]);
    const max = m[2] ? Number(m[2]) : null;
    if (min > 30 || (max !== null && max < min)) continue;
    // The headline requirement is usually the largest minimum mentioned.
    if (!best || min > best.min) best = { min, max };
  }
  return best;
}

// ── Skills ───────────────────────────────────────────────────────────────────

export function mentions(text: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  return new RegExp(`(^|[^a-z0-9+#.])${escapeRe(t.toLowerCase())}(?=$|[^a-z0-9+#])`, 'i').test(text.toLowerCase());
}

const KNOWN_SKILLS = [
  'Java', 'Python', 'JavaScript', 'TypeScript', 'Go', 'Golang', 'Rust', 'C++', 'C#', '.NET', 'Kotlin',
  'Swift', 'Scala', 'Ruby', 'PHP', 'SQL', 'NoSQL', 'React', 'React Native', 'Angular', 'Vue', 'Next.js',
  'Node.js', 'Express', 'Spring', 'Spring Boot', 'Django', 'Flask', 'FastAPI', 'Microservices', 'REST',
  'GraphQL', 'gRPC', 'Kafka', 'RabbitMQ', 'Redis', 'PostgreSQL', 'MySQL', 'MongoDB', 'Cassandra',
  'Elasticsearch', 'DynamoDB', 'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Terraform', 'Ansible',
  'Jenkins', 'CI/CD', 'GitHub Actions', 'Linux', 'Spark', 'Hadoop', 'Airflow', 'Snowflake', 'Databricks',
  'dbt', 'Tableau', 'Power BI', 'Excel', 'Pandas', 'NumPy', 'TensorFlow', 'PyTorch', 'scikit-learn',
  'Machine Learning', 'Deep Learning', 'NLP', 'LLM', 'Generative AI', 'Computer Vision', 'Data Science',
  'Data Engineering', 'ETL', 'Android', 'iOS', 'Flutter', 'HTML', 'CSS', 'Selenium', 'Cypress',
  'Playwright', 'Appium', 'JUnit', 'Agile', 'Scrum', 'Jira', 'SAP', 'Salesforce', 'ServiceNow',
  'System Design', 'Distributed Systems', 'DevOps', 'SRE', 'Product Management', 'Figma',
];

export function extractSkillsFromText(text: string): string[] {
  return KNOWN_SKILLS.filter((s) => mentions(text, s));
}

// ── Scoring ──────────────────────────────────────────────────────────────────

const STOP = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'in', 'at', 'for', 'to', 'with', 'i', 'ii', 'iii', '-']);
const tokens = (s: string) =>
  new Set(s.toLowerCase().split(/[^a-z0-9+#.]+/).filter((w) => w.length > 1 && !STOP.has(w)));

export interface Score {
  score: number;
  reasons: string[];
}

/**
 * 0-100: skills overlap (50) + title similarity (30) + experience fit (20).
 */
export function scoreJob(job: Pick<JobDetails, 'title' | 'description'>, me: MatchInput): Score {
  const reasons: string[] = [];
  const text = `${job.title}\n${job.description}`;

  const matched = [...new Set(me.skills)].filter((s) => mentions(text, s));
  const skillPts = Math.min(50, matched.length * 7);
  reasons.push(matched.length ? `skills: ${matched.slice(0, 8).join(', ')}` : 'no profile skills mentioned');

  const jt = tokens(job.title);
  let best = 0;
  for (const t of me.titles) {
    const mt = tokens(t);
    if (!mt.size || !jt.size) continue;
    const overlap = [...jt].filter((w) => mt.has(w)).length;
    best = Math.max(best, overlap / Math.min(jt.size, mt.size));
  }
  const titlePts = Math.round(best * 30);
  if (best > 0) reasons.push(`title ${Math.round(best * 100)}% similar to your roles`);

  let expPts = 12;
  const req = requiredYears(job.description);
  if (req) {
    if (me.years + 1 < req.min) {
      expPts = 0;
      reasons.push(`needs ${req.min}+ yrs, you have ${me.years}`);
    } else if (req.max !== null && me.years > req.max + 4) {
      expPts = 6;
      reasons.push(`likely over-qualified (${req.min}-${req.max} yrs)`);
    } else {
      expPts = 20;
      reasons.push(`experience fits (${req.min}${req.max ? `-${req.max}` : '+'} yrs)`);
    }
  }

  return { score: skillPts + titlePts + expPts, reasons };
}

export function titleExcluded(title: string, words: string[]): string | null {
  const w = words.find((x) => mentions(title, x));
  return w ? `title contains "${w}"` : null;
}

export function isBangalore(location: string): boolean {
  return !location || /bengaluru|bangalore|karnataka/i.test(location);
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exclusionReason, normalizeCompany, requiredYears, scoreJob, isBangalore, titleExcluded } from './matching.js';
import { resolveAnswer } from './answers.js';
import { parseExperience } from './linkedin/profile.js';
import { profileFromResume, roleFromResume, yearsFromExperiences, yearsFromResume } from './profile.js';
import { effectiveExclusions } from './agent.js';
import type { Settings } from './config.js';

test('normalizeCompany strips legal suffixes and punctuation', () => {
  assert.equal(normalizeCompany('Infosys Ltd.'), 'infosys');
  assert.equal(normalizeCompany('Tata Consultancy Services Pvt. Ltd'), 'tata consultancy services');
  assert.equal(normalizeCompany('Walmart Global Tech India'), 'walmart global tech');
});

test('employer and parent/group names are excluded', () => {
  const ex = ['Tata Consultancy Services', 'Walmart'];
  assert.ok(exclusionReason({ company: 'TCS', description: '' }, ['TCS']));
  assert.ok(exclusionReason({ company: 'Tata Consultancy Services Limited', description: '' }, ex));
  assert.ok(exclusionReason({ company: 'Walmart Global Tech India', description: '' }, ex), 'subsidiary of parent');
  assert.ok(exclusionReason({ company: 'Flipkart', description: '' }, ['Flipkart Internet Pvt Ltd']));
  assert.equal(exclusionReason({ company: 'Swiggy', description: '' }, ex), null);
  assert.equal(exclusionReason({ company: 'Tatamotors Finance', description: '' }, ['Tata']), null, 'whole words only');
});

test('staffing-agency posts for an excluded client are blocked, plain tech mentions are not', () => {
  const ex = ['Microsoft'];
  assert.ok(exclusionReason({ company: 'ABC Staffing', description: 'Our client Microsoft is hiring a backend engineer' }, ex));
  assert.ok(exclusionReason({ company: 'XYZ HR', description: 'Hiring for Microsoft, Bengaluru. 5 yrs exp.' }, ex));
  assert.equal(exclusionReason({ company: 'Startup', description: 'Experience with Microsoft Azure preferred' }, ex), null);
});

test('jobs with no company name are never applied to', () => {
  assert.ok(exclusionReason({ company: '', description: 'x' }, ['Acme']));
});

test('effectiveExclusions merges manual list with detected current employer', () => {
  const s = { excludedCompanies: ['Walmart'], autoExcludeCurrentEmployer: true } as Settings;
  const profile = {
    experiences: [
      { title: 'SDE 2', company: 'Flipkart', dates: 'Jan 2022 - Present', current: true },
      { title: 'SDE', company: 'Infosys', dates: '2018 - 2021', current: false },
    ],
  } as never;
  assert.deepEqual(effectiveExclusions(s, profile), ['Walmart', 'Flipkart']);
  assert.deepEqual(effectiveExclusions({ ...s, autoExcludeCurrentEmployer: false }, profile), ['Walmart']);
});

test('requiredYears reads common phrasings', () => {
  assert.deepEqual(requiredYears('We need 5+ years of experience in Java'), { min: 5, max: null });
  assert.deepEqual(requiredYears('3-6 yrs exp'), { min: 3, max: 6 });
  assert.deepEqual(requiredYears('4 to 8 years'), { min: 4, max: 8 });
  assert.equal(requiredYears('No experience mentioned'), null);
});

test('scoreJob rewards skill/title/experience fit and penalises under-qualification', () => {
  const me = { titles: ['Senior Software Engineer'], skills: ['Java', 'Spring Boot', 'Kafka', 'AWS', 'Kubernetes'], years: 6 };
  const good = scoreJob({ title: 'Senior Software Engineer - Backend', description: 'Java, Spring Boot, Kafka, AWS. 5-8 years.' }, me);
  const bad = scoreJob({ title: 'Engineering Director', description: 'Python. 15+ years of experience' }, me);
  assert.ok(good.score >= 75, `good=${good.score}`);
  assert.ok(bad.score < 30, `bad=${bad.score}`);
  assert.ok(good.score > bad.score);
});

test('location and title filters', () => {
  assert.ok(isBangalore('Bengaluru, Karnataka, India'));
  assert.ok(isBangalore('Bangalore Urban'));
  assert.ok(!isBangalore('Hyderabad, Telangana'));
  assert.ok(titleExcluded('Software Engineer Intern', ['intern']));
  assert.equal(titleExcluded('Internal Tools Engineer', ['intern']), null);
});

test('resolveAnswer answers truthfully or returns null', () => {
  const ctx = {
    answers: { phone: '9876543210', noticePeriodDays: 30, expectedCtcLakhs: 30, currentCtcLakhs: 22, custom: [{ match: 'gender', answer: 'Prefer not to say' }] },
    skills: ['Java', 'Kafka'],
    years: 6.4,
    profileUrl: 'https://linkedin.com/in/me',
  };
  assert.equal(resolveAnswer('Mobile phone number', 'text', [], ctx), '9876543210');
  assert.equal(resolveAnswer('How many years of experience do you have with Java?', 'number', [], ctx), '6');
  assert.equal(resolveAnswer('How many years of experience do you have with Golang?', 'number', [], ctx), null);
  assert.equal(resolveAnswer('Notice period (in days)', 'number', [], ctx), '30');
  assert.equal(resolveAnswer('Expected CTC (in LPA)', 'text', [], ctx), '30');
  assert.equal(resolveAnswer('Do you require visa sponsorship?', 'radio', ['Yes', 'No'], ctx), 'No');
  assert.equal(resolveAnswer('Are you comfortable working from office in Bengaluru?', 'select', ['Select an option', 'Yes', 'No'], ctx), 'Yes');
  assert.equal(resolveAnswer('Do you have experience with Kafka?', 'radio', ['Yes', 'No'], ctx), 'Yes');
  assert.equal(resolveAnswer('Do you have experience with Rust?', 'radio', ['Yes', 'No'], ctx), null);
  assert.equal(resolveAnswer('Total years of experience', 'select', ['0-2 years', '3-5 years', '6-10 years'], ctx), '6-10 years');
  assert.equal(resolveAnswer('Gender', 'select', ['Male', 'Female', 'Prefer not to say'], ctx), 'Prefer not to say');
  assert.equal(resolveAnswer('What is your favourite colour?', 'text', [], ctx), null);
});

test('parseExperience handles single and grouped roles and finds the current employer', () => {
  const exps = parseExperience([
    ['Senior Software Engineer', 'Senior Software Engineer', 'Acme Technologies · Full-time', 'Mar 2021 - Present · 3 yrs 8 mos', 'Bengaluru'],
    ['Infosys', '5 yrs', 'Technology Analyst', 'Full-time', 'Jan 2018 - Feb 2021 · 3 yrs 2 mos', 'Systems Engineer', 'Jun 2016 - Dec 2017 · 1 yr 7 mos'],
  ]);
  assert.deepEqual(exps.map((e) => [e.title, e.company, e.current]), [
    ['Senior Software Engineer', 'Acme Technologies', true],
    ['Technology Analyst', 'Infosys', false],
    ['Systems Engineer', 'Infosys', false],
  ]);
  assert.equal(yearsFromExperiences(exps, new Date('2026-06-01')), 10);
});

test('resume parsing: role, years and skills', () => {
  const cv = 'Priya Sharma\nSr. Software Engineer\nAcme — Mar 2021 – Present\nInfosys, Jul 2017 to Feb 2021\nJava, Kafka, AWS';
  const now = new Date('2026-10-16');
  assert.equal(roleFromResume(cv), 'Senior Software Engineer');
  assert.equal(yearsFromResume(cv, now), 9.3);
  assert.equal(yearsFromResume('No dates here'), 0);
  const p = profileFromResume(cv);
  assert.equal(p.name, 'Priya Sharma');
  assert.deepEqual(p.skills, ['Java', 'Kafka', 'AWS']);
  assert.equal(p.profileUrl, '', 'resume-only profile must not count as synced from LinkedIn');
});

test('parseExperienceText reads roles from plain page text (layout-independent)', async () => {
  const { parseExperienceText } = await import('./linkedin/profile.js');
  const lines = [
    'Experience',
    'Principal Engineer', 'Dell Technologies · Full-time', 'Apr 2019 - Present · 7 yrs 7 mos', 'Bengaluru, Karnataka, India',
    'Infosys', 'Full-time · 5 yrs 2 mos', 'Technology Lead', 'Jan 2016 - Mar 2019 · 3 yrs 3 mos',
    'Senior Engineer', 'Full-time', 'Feb 2014 - Dec 2015 · 1 yr 11 mos',
  ];
  assert.deepEqual(parseExperienceText(lines).map((e) => [e.title, e.company, e.current]), [
    ['Principal Engineer', 'Dell Technologies', true],
    ['Technology Lead', 'Infosys', false],
    ['Senior Engineer', 'Infosys', false],
  ]);
});

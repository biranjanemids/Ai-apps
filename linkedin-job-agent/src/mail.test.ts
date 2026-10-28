import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractVerification } from './mail.js';
import { autopilotDefault } from './answers.js';

test('verification link from a Workday email', () => {
  const v = extractVerification(
    {
      subject: 'Verify your candidate account',
      from: 'Cadence <cadence@myworkday.com>',
      text: 'Please verify your email to continue your application with Cadence.',
      html: '<a href="https://cadence.wd1.myworkdayjobs.com/en-US/External/privacy">Privacy</a><a href="https://cadence.wd1.myworkdayjobs.com/en-US/External/activate/abc123?token=xyz&amp;s=1">Verify Account</a>',
    },
    'cadence',
  );
  assert.deepEqual(v, { link: 'https://cadence.wd1.myworkdayjobs.com/en-US/External/activate/abc123?token=xyz&s=1' });
});

test('one-time code from an email', () => {
  assert.deepEqual(extractVerification({ subject: 'Your sign-in code', from: 'Oracle Recruiting <no-reply@oracle.com>', text: 'Your one-time code is: 482915. It expires in 10 minutes.' }, 'oracle'), { code: '482915' });
});

test('ignores unrelated or non-verification mail', () => {
  assert.equal(extractVerification({ subject: 'Your weekly digest', text: 'Top stories 2026' }, 'acme'), null);
  assert.equal(extractVerification({ subject: 'Verify your account', from: 'shop@example.com', text: 'Verify your Shop account' }, 'cadence'), null);
});

test('autopilot answers willingness and acknowledgements, not facts', () => {
  assert.equal(autopilotDefault('I agree to the privacy policy *', 'checkbox', []), 'Yes');
  assert.equal(autopilotDefault('Are you willing to undergo a background check?', 'radio', ['Yes', 'No']), 'Yes');
  assert.equal(autopilotDefault('Have you ever been convicted of a criminal offence? I confirm…', 'radio', ['Yes', 'No']), null);
  assert.equal(autopilotDefault('Years of experience with Rust', 'number', []), null);
});

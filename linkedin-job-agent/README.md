# LinkedIn Job Agent (Bengaluru)

An agent you control from your phone. It reads **your LinkedIn profile and resume**, finds
**Easy Apply jobs in Bengaluru** that fit your skills, job titles and years of experience,
ranks them best match first and applies. It **never applies to your own company**.

## How it decides

| Step | What happens |
|------|--------------|
| Profile | Reads your headline, experience (including your **current employer**) and skills from LinkedIn, plus skills found in your resume (`RESUME_PATH`, PDF or text). |
| Search | LinkedIn Jobs in Bengaluru (`geoId 105214831`), Easy Apply only. Keywords come from your current job titles, or from `KEYWORDS`. |
| **Block your company** | A job is skipped if the employer matches `EXCLUDED_COMPANIES` **or** your current employer on LinkedIn. Names are normalized first, so `Pvt Ltd`, `India` and punctuation are ignored. Matching is on whole words, so "Walmart" also catches subsidiaries like "Walmart Global Tech India". Staffing-agency posts that say "our client *X* is hiring" are blocked too. Jobs with no company name are never applied to. The check runs again right before each submit, and live mode won't start if the block list is empty. |
| Score 0–100 | Skills overlap (50 points) + how close the title is to your roles (30) + experience fit against "5+ yrs" or "3-6 yrs" in the posting (20). If you set `GROQ_API_KEY`, an LLM also rates the job against your resume and the two scores are averaged. |
| Apply | Highest scores first, up to `MAX_APPLICATIONS_PER_RUN` and `MAX_APPLICATIONS_PER_DAY`, waiting 20–45 s between applications. Screening questions are answered from your profile and `answers.json`. **If a question can't be answered truthfully** (for example, years with a skill you don't list), the job goes to **"Needs you"** on the phone instead of the agent guessing. |

## Setup (once, on a laptop, PC or small server)

The browser runs on a computer, because phones can't run Playwright. You control it from your phone.

```bash
cd linkedin-job-agent
npm install
npx playwright install chromium
cp .env.example .env                   # set DASHBOARD_TOKEN, EXCLUDED_COMPANIES, RESUME_PATH
cp answers.example.json answers.json   # your phone, notice period, CTC, etc.
npm run build
npm run login          # opens a browser: log in to LinkedIn (2FA works); the session is saved locally
npm run sync-profile   # reads your profile and resume, and prints the current employer it found
npm start              # phone dashboard on http://<computer-ip>:8787
```

`EXCLUDED_COMPANIES`: list your employer **and** its parent or group company and any short names
(for example `Tata Consultancy Services,TCS,Tata Group`). Before going live, check that the
"Never apply to" card on the phone shows all of them.

On a headless server, skip `npm run login` and set `LINKEDIN_LI_AT` to the value of the
`li_at` cookie from a browser where you're logged in.

## Using it from your phone

1. Make the dashboard reachable from your phone. Options: the same Wi-Fi (`http://192.168.x.x:8787`),
   [Tailscale](https://tailscale.com) on both computer and phone (recommended because it stays private),
   or a Cloudflare tunnel.
2. Open `http://<host>:8787/#token=<DASHBOARD_TOKEN>` once and the token is remembered.
   Use **Add to Home Screen** in your phone's browser to get an app icon.
3. Tap **Find jobs (dry run)**. In the **Dry run** tab, review the matches, scores and reasons.
4. Turn on **Live mode** (it shows your block list and asks you to confirm), then tap **Find & apply now**.
   To run on a schedule instead, set `RUN_EVERY_MINUTES=240`.
5. Check **Needs you** for jobs with questions only you can answer, and tap one to open it in LinkedIn.

Optional: install the [ntfy](https://ntfy.sh) app and subscribe to your `NTFY_TOPIC` to get a push
notification after every run.

## Important

- **LinkedIn's User Agreement prohibits automated activity.** Using this agent can get your account
  restricted. Keep the daily limits low, don't run it around the clock, and use it at your own risk.
- LinkedIn changes its page markup often. If searching or applying stops working, the selectors in
  `src/linkedin/*.ts` need updating.
- All data (login session, profile, job history) stays in `data/` on your computer.

## Commands

| Command | What it does |
|-|-|
| `npm run login` | Log in once (opens a visible browser) |
| `npm run sync-profile` | Re-read your LinkedIn profile and resume |
| `npm run run` | Run one search-and-apply pass from the terminal |
| `npm start` | Start the phone dashboard, plus the scheduler if `RUN_EVERY_MINUTES` > 0 |
| `npm test` | Unit tests (company blocking, scoring, answers, profile parsing) |

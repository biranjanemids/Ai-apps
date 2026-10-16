# LinkedIn Job Agent (Bengaluru)

An agent you control from your phone. It reads **your LinkedIn profile and resume**, finds
**Easy Apply jobs in Bengaluru** that fit your skills, job titles and years of experience,
ranks them best match first and applies. It **never applies to your own company**.

## How it decides

| Step | What happens |
|------|--------------|
| Profile | Reads your headline, experience (including your **current employer**) and skills from LinkedIn, plus skills found in your resume (`RESUME_PATH`, PDF or text). |
| Search | LinkedIn Jobs in Bengaluru (`geoId 105214831`): Easy Apply **and** company-website jobs (set **Which jobs** to "Easy Apply only" to narrow it). Keywords come from your current job titles, or from `KEYWORDS`. |
| **Block your company** | A job is skipped if the employer matches `EXCLUDED_COMPANIES` **or** your current employer on LinkedIn. Names are normalized first, so `Pvt Ltd`, `India` and punctuation are ignored. Matching is on whole words, so "Walmart" also catches subsidiaries like "Walmart Global Tech India". Staffing-agency posts that say "our client *X* is hiring" are blocked too. Jobs with no company name are never applied to. The check runs again right before each submit, and live mode won't start if the block list is empty. |
| Score 0–100 | Skills overlap (50 points) + how close the title is to your roles (30) + experience fit against "5+ yrs" or "3-6 yrs" in the posting (20). If you set `GROQ_API_KEY`, an LLM also rates the job against your resume and the two scores are averaged. |
| Company websites | For jobs whose **Apply** button leads to the company's site, the agent fills the form itself on Greenhouse, Lever, Ashby, SmartRecruiters and simple company forms: name, email, phone, resume upload, LinkedIn URL and screening questions. Portals that need an account (Workday, Taleo, iCIMS, SuccessFactors, Naukri…), captchas and questions it can't answer truthfully go to **Needs you** with an **Open application** link. |
| AI (optional) | With a free [Groq](https://console.groq.com/keys) key, pasted on the dashboard's **AI assistant** card: (1) AI also rates each job against your resume, and the score is averaged with the formula's; (2) it answers open questions such as "Why do you want to join?" or "Years with Spring?" using **only** facts in your resume and profile, and returns nothing rather than inventing; (3) it suggests extra search titles; (4) it writes cover notes, as text or as an uploaded PDF. It never answers salary, notice period, visa, consent or personal questions, and never decides where to apply or overrides the company block. Every AI answer is shown on the job in the dashboard. |
| Apply | Highest scores first, up to `MAX_APPLICATIONS_PER_RUN` and `MAX_APPLICATIONS_PER_DAY`, waiting 20–45 s between applications. Screening questions are answered from your profile and `answers.json`. **If a question can't be answered truthfully** (for example, years with a skill you don't list), the job goes to **"Needs you"** on the phone instead of the agent guessing. |

## Web version (open it from any browser)

The same agent runs on a cloud server, and you open it at a web address from your phone or laptop.
On a laptop the dashboard shows two columns, and you can drag your resume PDF onto the **Resume** card.

**Deploy on Render** (about 5 minutes):

1. Click [**Deploy to Render**](https://render.com/deploy?repo=https://github.com/biranjanemids/Ai-apps/tree/claude/linkedin-bangalore-job-agent-x13ndj)
   and sign in with GitHub. This uses `render.yaml` in the repo root.
2. When asked, fill in `EXCLUDED_COMPANIES` (your company and its parent/group). `GROQ_API_KEY` and `NTFY_TOPIC` are optional.
3. When it finishes, open the service → **Environment** and copy the generated `DASHBOARD_TOKEN`.
4. Open `https://<your-service>.onrender.com/#token=<DASHBOARD_TOKEN>`, then:
   **Upload resume → Connect LinkedIn → My answers → check Never apply to → Find jobs (dry run)**.

Cost: the plan includes a 1 GB disk that keeps your login, resume and history across restarts.
That needs Render's Starter plan (about US$7/month); the free plan has no disk.

**Or run the same container on any computer with Docker (free):**

```bash
cd linkedin-job-agent
docker build -t job-agent .
docker run -d --name job-agent -p 8787:8787 -v job-agent-data:/data \
  -e DASHBOARD_TOKEN=$(openssl rand -hex 24) -e EXCLUDED_COMPANIES="Your Company,Parent Group" job-agent
docker logs job-agent   # prints the dashboard link with your token
```

Notes for the web version:
- Anyone with the dashboard link and token can control the agent, so keep the token private.
- LinkedIn may ask for an extra verification code the first time you log in from a cloud server. Enter it on the Connect LinkedIn screen.
- Uploading your resume first is fine. The agent still reads your LinkedIn profile before every run, so your current company is always detected and blocked.

## Run it on your Android phone (no computer needed)

Everything runs on the phone itself: the agent, its browser, your LinkedIn login and your job history.

1. Install **Termux** from [F-Droid](https://f-droid.org/packages/com.termux/). The Play Store version is outdated and won't work.
   Optional: also install **Termux:API** (phone notifications) and **Termux:Widget** (a home-screen start button), both from F-Droid.
2. Open Termux and paste this. It updates Termux first; on a fresh install `curl` can fail with
   `cannot locate symbol "SSL_..."` until the update has run.
   ```bash
   pkg upgrade -y && curl -fsSL https://raw.githubusercontent.com/biranjanemids/Ai-apps/claude/linkedin-bangalore-job-agent-x13ndj/linkedin-job-agent/termux/setup.sh | bash
   ```
   This takes about 5–10 minutes. It installs Node.js and Chromium, downloads the agent and creates a private dashboard password.
3. Start it with `bash ~/Ai-apps/linkedin-job-agent/termux/start.sh` or the **Job Agent** widget.
   The dashboard opens in your phone's browser, and you can use **Add to Home Screen** there.
4. In the dashboard:
   1. **Connect LinkedIn**: the agent's browser appears on screen. Tap the email box, type, press Enter, and do the same
      for the password and any OTP code. Your password isn't saved; only the login session is.
   2. **Upload your resume** (PDF) in the Profile card.
   3. Fill in **My answers** (phone, notice period, CTC).
   4. Check **Never apply to**. Your current company is added automatically from your profile. Add the parent or group name too.
   5. Tap **Find jobs (dry run)**, review the matches, then turn on **Live mode**.
5. Android may kill apps running in the background. Go to *Settings → Apps → Termux → Battery* and set it to **Unrestricted**.
   `start.sh` holds a wake lock, so runs keep going with the screen off. To stop the agent, use `termux/stop.sh` or the **Stop Job Agent** widget.

### Keep it running in the background

The agent runs inside **Termux**, not in your browser, so you can close the browser. The dashboard is only a remote control.
Android may still pause or kill Termux in the background, so do these once:

1. **Battery:** Settings → Apps → Termux → Battery → **Unrestricted**. On Xiaomi/Redmi/POCO also turn on **Autostart**; on Samsung, add Termux to **Never sleeping apps**; on Oppo/Vivo/Realme allow **background activity**.
2. **Keep Termux in Recents:** don't swipe Termux away. Lock it in the recent-apps screen if your phone offers that (long-press its card → Lock).
3. **Android 12 and newer:** Android kills apps that run many background processes, and Chromium does. To stop that:
   - **Android 14+:** Settings → About phone → tap *Build number* 7 times → Developer options → turn on **Disable child process restrictions**.
   - **Android 12–13:** from a computer with ADB:
     `adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent; /system/bin/device_config put activity_manager max_phantom_processes 2147483647"`
4. Optional: install **Termux:Boot** from F-Droid and open it once. The agent then starts by itself when the phone reboots.
5. Optional: install **Termux:API** from F-Droid to get a pinned notification showing progress ("Applying 3/15: …").

The agent also protects itself:
- If it's killed, it restarts within 5 seconds.
- An interrupted run resumes by itself.
- Matches waiting to be applied are kept.
- With **Settings → Run automatically**, it searches and applies every few hours without you opening anything.

To update later, run the same `curl … | bash` line again. Your data and `.env` are kept.

**Is it working?** Run `bash ~/Ai-apps/linkedin-job-agent/termux/check.sh`, or tap the **Check Job Agent** widget.
It checks Node.js, Chromium, the dashboard, internet access to LinkedIn, your LinkedIn login, profile, resume,
company block list, answers and recent errors, then prints ✅ / ⚠️ / ❌ for each. Copy the output when asking for help.
On a computer, run `npm run doctor`.

## Setup on a laptop, PC or server (alternative)

Here the browser runs on the computer and you open the dashboard from your phone.

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

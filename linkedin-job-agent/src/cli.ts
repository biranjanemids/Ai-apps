#!/usr/bin/env node
import './platform.js';
import { openBrowser, isLoggedIn, sleep } from './linkedin/browser.js';
import { agent } from './agent.js';
import { startServer } from './server.js';
import { doctor } from './doctor.js';

async function login() {
  console.log('A browser window will open. Log in to LinkedIn (incl. 2FA); the session is saved in data/browser-profile.');
  const ctx = await openBrowser({ headless: false });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto('https://www.linkedin.com/login');
  for (let i = 0; i < 300; i++) {
    await sleep(2000);
    if (/linkedin\.com\/(feed|in\/|jobs)/.test(page.url())) break;
  }
  const ok = await isLoggedIn(page);
  await ctx.close();
  console.log(ok ? 'Logged in ✔  Now run: npm run sync-profile' : 'Login not detected — try again.');
  process.exit(ok ? 0 : 1);
}

const cmd = process.argv[2];
switch (cmd) {
  case 'login':
    await login();
    break;
  case 'sync-profile':
    await agent.syncProfile();
    break;
  case 'run':
    console.log(await agent.run());
    break;
  case 'doctor':
    await doctor();
    process.exit(0);
  case 'serve':
    startServer();
    break;
  default:
    console.log('Usage: node dist/cli.js <login|sync-profile|run|serve|doctor>');
    process.exit(1);
}

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, VERSION } from './config.js';
import { readMemory } from './linkedin/siteMemory.js';
import { store } from './store.js';

/** What happened to each application, without starting the browser (safe while a run is going). */
export function report(): void {
  const tried = store
    .list()
    .filter((r) => ['applied', 'needs_attention', 'failed', 'dry_run', 'queued'].includes(r.status))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const icon: Record<string, string> = { applied: '✅', dry_run: '🧪', needs_attention: '🙋', failed: '❌', queued: '⏳' };
  console.log(`Job Agent ${VERSION} — application report\n`);
  const counts = tried.reduce<Record<string, number>>((c, r) => ((c[r.status] = (c[r.status] ?? 0) + 1), c), {});
  console.log(Object.entries(counts).map(([k, v]) => `${icon[k]} ${k}: ${v}`).join('   ') || 'No applications attempted yet.');
  console.log('');
  for (const r of tried.slice(0, 25)) {
    console.log(`${icon[r.status]} ${r.at.slice(5, 16).replace('T', ' ')}  ${r.title.slice(0, 50)} @ ${r.company.slice(0, 30)} (${r.score})`);
    if (r.note) console.log(`     ${r.note.slice(0, 220)}`);
    if (r.applyUrl && r.status !== 'applied') console.log(`     ${r.applyUrl.split('?')[0].slice(0, 120)}`);
  }
  const sites = Object.entries(readMemory());
  if (sites.length) {
    console.log('\nCareers sites:');
    for (const [k, m] of sites.slice(0, 15)) console.log(`  ${k}: ${m.applied} ok, ${m.failed} not${m.learned ? ' (learned by AI)' : ''}${m.lastNote ? ` — ${m.lastNote.slice(0, 90)}` : ''}`);
  }
  // Was the agent killed mid-run? Restarts show up in the log
  try {
    const log = fs.readFileSync(path.join(DATA_DIR, 'agent.log'), 'utf8').split('\n');
    const today = log.filter((l) => /Agent exited — restarting|Watchdog:|was interrupted|restarting the browser/.test(l)).slice(-5);
    if (today.length) console.log(`\nRestarts (Android killed the agent):\n  ${today.join('\n  ')}`);
  } catch {
    // no log yet
  }
}

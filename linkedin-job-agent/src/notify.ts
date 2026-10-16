import { execFile } from 'node:child_process';
import { env } from './config.js';

/**
 * Phone notification. On Android (Termux with the Termux:API app) it posts a native
 * notification; otherwise/also it can push via the free ntfy app (https://ntfy.sh).
 */
export async function notify(title: string, message: string, url?: string): Promise<void> {
  if (process.platform === 'android') {
    const args = ['--title', title, '--content', message, '--id', 'job-agent'];
    if (url) args.push('--action', `termux-open-url ${url}`);
    execFile('termux-notification', args, () => {}); // no-op if Termux:API isn't installed
  }
  if (!env.ntfyTopic) return;
  const headers: Record<string, string> = { Title: title.replace(/[^\x20-\x7E]/g, '') };
  if (url) headers.Click = url;
  await fetch(`https://ntfy.sh/${encodeURIComponent(env.ntfyTopic)}`, { method: 'POST', body: message, headers }).catch(() => {});
}

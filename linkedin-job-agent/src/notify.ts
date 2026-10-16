import { env } from './config.js';

/** Push notification to your phone via the free ntfy app (https://ntfy.sh). */
export async function notify(title: string, message: string, url?: string): Promise<void> {
  if (!env.ntfyTopic) return;
  const headers: Record<string, string> = { Title: title.replace(/[^\x20-\x7E]/g, '') };
  if (url) headers.Click = url;
  await fetch(`https://ntfy.sh/${encodeURIComponent(env.ntfyTopic)}`, { method: 'POST', body: message, headers }).catch(() => {});
}

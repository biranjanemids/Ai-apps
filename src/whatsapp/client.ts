import axios from 'axios';

const BASE_URL = 'https://graph.facebook.com/v18.0';

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

function getPhoneNumberId(): string {
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!id) throw new Error('WHATSAPP_PHONE_NUMBER_ID is not set');
  return id;
}

const SEND_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;

async function post(body: Record<string, unknown>): Promise<void> {
  const phoneNumberId = getPhoneNumberId();
  const url = `${BASE_URL}/${phoneNumberId}/messages`;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await axios.post(url, body, { headers: getHeaders(), timeout: SEND_TIMEOUT_MS });
      return;
    } catch (err) {
      lastErr = err;
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      // Retry only on network errors, rate limiting, or server errors
      const retriable = status === undefined || status === 429 || status >= 500;
      if (!retriable || attempt === MAX_RETRIES) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }

  const detail = axios.isAxiosError(lastErr)
    ? JSON.stringify(lastErr.response?.data ?? lastErr.message)
    : lastErr;
  console.error('[WhatsApp] Send failed after retries:', detail);
  throw lastErr;
}

// ── Text message ──────────────────────────────────────────────────────────────

export async function sendTextMessage(to: string, text: string): Promise<void> {
  const chunks = chunkText(text, 4096);
  for (const chunk of chunks) {
    await post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: chunk, preview_url: true },
    });
  }
}

// ── Interactive button message ────────────────────────────────────────────────
// Max 3 buttons, each title max 20 chars

export interface WhatsAppButton {
  id: string;    // passed back in webhook on click (max 256 chars)
  title: string; // shown to user (max 20 chars)
}

export async function sendButtonMessage(
  to: string,
  bodyText: string,
  buttons: WhatsAppButton[],
  headerText?: string,
  footerText?: string,
  headerImageUrl?: string
): Promise<void> {
  const interactive: Record<string, unknown> = {
    type: 'button',
    body: { text: bodyText.slice(0, 1024) },
    action: {
      buttons: buttons.slice(0, 3).map((b) => ({
        type: 'reply',
        reply: {
          id: b.id.slice(0, 256),
          title: b.title.slice(0, 20),
        },
      })),
    },
  };
  // Image header takes priority (a button message has one header, image OR text)
  if (headerImageUrl) {
    interactive['header'] = { type: 'image', image: { link: headerImageUrl } };
  } else if (headerText) {
    interactive['header'] = { type: 'text', text: headerText.slice(0, 60) };
  }
  if (footerText) interactive['footer'] = { text: footerText.slice(0, 60) };

  await post({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive,
  });
}

// ── Interactive list message ─────────────────────────────────────────────────
// Up to 10 rows, great for showing search results as a tappable menu

export interface ListRow {
  id: string;
  title: string;       // max 24 chars
  description?: string; // max 72 chars
}

export async function sendListMessage(
  to: string,
  bodyText: string,
  buttonLabel: string,
  sectionTitle: string,
  rows: ListRow[]
): Promise<void> {
  await post({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText.slice(0, 1024) },
      action: {
        button: buttonLabel.slice(0, 20),
        sections: [
          {
            title: sectionTitle.slice(0, 24),
            rows: rows.slice(0, 10).map((r) => ({
              id: r.id.slice(0, 200),
              title: r.title.slice(0, 24),
              description: (r.description ?? '').slice(0, 72),
            })),
          },
        ],
      },
    },
  });
}

// ── Interactive CTA-URL message ───────────────────────────────────────────────
// A single button that OPENS A LINK directly (image header supported) — the
// best primitive for "tap to buy on the store".

export async function sendCtaUrlMessage(
  to: string,
  bodyText: string,
  buttonLabel: string,
  url: string,
  headerImageUrl?: string,
  footerText?: string
): Promise<void> {
  const interactive: Record<string, unknown> = {
    type: 'cta_url',
    body: { text: bodyText.slice(0, 1024) },
    action: {
      name: 'cta_url',
      parameters: {
        display_text: buttonLabel.slice(0, 20),
        url,
      },
    },
  };
  if (headerImageUrl) interactive['header'] = { type: 'image', image: { link: headerImageUrl } };
  if (footerText) interactive['footer'] = { text: footerText.slice(0, 60) };

  await post({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive,
  });
}

// ── Mark as read ──────────────────────────────────────────────────────────────

export async function markAsRead(messageId: string): Promise<void> {
  const phoneNumberId = getPhoneNumberId();
  await axios
    .post(
      `${BASE_URL}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      { headers: getHeaders() }
    )
    .catch(() => { /* non-critical */ });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    // Prefer breaking at a newline so we don't split a product entry mid-line
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < maxLen / 2) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

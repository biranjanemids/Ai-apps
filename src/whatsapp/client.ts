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

async function post(body: Record<string, unknown>): Promise<void> {
  const phoneNumberId = getPhoneNumberId();
  await axios.post(`${BASE_URL}/${phoneNumberId}/messages`, body, {
    headers: getHeaders(),
  });
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
  footerText?: string
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
  if (headerText) interactive['header'] = { type: 'text', text: headerText.slice(0, 60) };
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
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + maxLen));
    start += maxLen;
  }
  return chunks;
}

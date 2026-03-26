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

export async function sendTextMessage(to: string, text: string): Promise<void> {
  const phoneNumberId = getPhoneNumberId();
  // WhatsApp messages have a 4096 char limit; chunk if needed
  const chunks = chunkText(text, 4096);

  for (const chunk of chunks) {
    await axios.post(
      `${BASE_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: chunk, preview_url: true },
      },
      { headers: getHeaders() }
    );
  }
}

export async function markAsRead(messageId: string): Promise<void> {
  const phoneNumberId = getPhoneNumberId();
  await axios
    .post(
      `${BASE_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      },
      { headers: getHeaders() }
    )
    .catch(() => {
      // Non-critical — ignore errors marking as read
    });
}

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

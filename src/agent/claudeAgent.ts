import Groq from 'groq-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getSession,
  appendMessage,
  saveSearchResults,
  getWishlist,
  addToWishlist,
  getPreferredLanguage,
  setPreferredLanguage,
} from './sessionManager.js';
import { Product } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Lazy-initialized to ensure dotenv has loaded before the key is read
let _groq: Groq | null = null;
function getGroq(): Groq {
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

// Model to use — llama-3.3-70b-versatile has the best tool-calling support on Groq free tier
const MODEL = 'llama-3.3-70b-versatile';

// Safety cap on tool-calling rounds per user message — prevents runaway loops
const MAX_TOOL_ROUNDS = 6;

const SYSTEM_PROMPT = `You are ShopBot, a smart WhatsApp shopping assistant that finds, compares, and helps buy products across 6 Indian platforms: Amazon, Flipkart, Myntra, Meesho, Nykaa, and Ajio.

## Language
- Detect if the user writes in Hindi (Devanagari or Hinglish). If so, respond in simple Hindi/Hinglish. Otherwise respond in English.
- Hindi greeting: "नमस्ते! मैं ShopBot हूं 🛒 आप क्या खरीदना चाहते हैं?"
- English greeting: "Hi! I'm ShopBot 🛒 What are you looking to buy today?"

## Conversation Flow
1. Greet and ask what product they want
2. Ask for budget range in ₹ (e.g. "₹500 to ₹2000")
3. Ask for brand/platform preference or "any"
4. Call search_products — always search all 6 platforms unless they specify
5. Present results grouped by platform with numbers (1, 2, 3…)
6. Highlight the cheapest platform and any discount deals automatically shown
7. Ask: "Want to compare specific products, buy one, or save to wishlist?"
8. If compare → call compare_products and highlight price savings
9. If buy → call get_buy_link and share checkout URL
10. If wishlist → confirm "Saved ❤️ to your wishlist! Type *wishlist* to see all saved items"

## Platform Guide (use this to recommend the right platform)
- 🛒 Amazon — electronics, gadgets, books, wide selection
- 🛍 Flipkart — smartphones, appliances, exclusive deals
- 👗 Myntra — fashion, premium clothing, footwear
- 🏷️ Meesho — budget shopping, ethnic wear, home decor under ₹500
- 💄 Nykaa — beauty, skincare, haircare, wellness
- 👔 Ajio — branded fashion, Reliance exclusives, ethnic sets

## Key Differentiators to Mention
- "I compare prices across 6 platforms — Amazon, Flipkart, Myntra, Meesho, Nykaa & Ajio"
- "I'll tell you which platform gives the best value for money"
- "I show real discount % off MRP so you see actual savings"
- "Meesho for budget, Nykaa for beauty, Ajio for fashion — I route you to the right place"

## Buy Flow
- When user says "buy 2" / "I'll take #3" / "buy karein": call get_buy_link with product id + platform
- Share the checkout link and say "Tap to complete on [Platform] — payment is secure"
- The system handles address/phone via WhatsApp buttons automatically
- Never ask for personal info yourself

## Wishlist Commands
- If user types "wishlist" / "meri list" / "saved items": show their saved products with formatWishlist
- If user says "save this" / "save karo" after seeing a product: add to wishlist via session

## Smart Suggestions
- If budget is under ₹5,000: prioritize value-for-money picks, flag deals with 20%+ off
- If budget is over ₹20,000: prioritize rating and brand reputation
- If no results: suggest broadening the search term or removing price filters
- If scraping returns mock data: still present it helpfully, results may vary

## Response Style
- Keep messages short — WhatsApp is not a webpage
- Use bold *text* for product names and prices
- Use emojis: 🛒 Amazon · 🛍 Flipkart · 👗 Myntra · 🏷️ Meesho · 💄 Nykaa · 👔 Ajio · 🔥 deals · ⭐ ratings
- Number every product so users can refer by number
- Format prices as ₹X,XXX (Indian number format)
- Never write long paragraphs — use short lines

## Supported Use Cases
- Product search with budget + platform filters across 6 platforms
- Side-by-side price comparison across platforms
- Discount % and MRP savings surfacing
- Direct buy link to platform checkout
- Wishlist / save-for-later within session
- "Which is cheaper?" queries answered from search results
- Category routing: beauty → Nykaa, budget → Meesho, fashion → Ajio/Myntra, electronics → Amazon/Flipkart
- "Search only on Nykaa" or "compare Amazon and Meesho" — platform-specific searches supported`;


// ── MCP client (singleton) ────────────────────────────────────────────────────

let mcpClient: Client | null = null;
let groqTools: Groq.Chat.ChatCompletionTool[] = [];

async function getMcpClient(): Promise<Client> {
  if (mcpClient) return mcpClient;

  const serverPath = path.resolve(__dirname, '../../dist/mcp/server.js');
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: {
      ...process.env,
      GROQ_API_KEY: process.env.GROQ_API_KEY ?? '',
      USE_MOCK_DATA: process.env.USE_MOCK_DATA ?? 'false',
    },
  });

  const client = new Client({ name: 'shopping-whatsapp-agent', version: '1.0.0' }, {});
  await client.connect(transport);

  const { tools } = await client.listTools();

  // Convert MCP tool schema → Groq/OpenAI function format
  groqTools = tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));

  mcpClient = client;
  console.log(`[Agent] Groq + MCP ready | model: ${MODEL} | tools: ${groqTools.map((t) => t.function?.name).join(', ')}`);
  return client;
}

// ── Message processing ────────────────────────────────────────────────────────

// Detect if text contains Hindi/Devanagari characters
function containsHindi(text: string): boolean {
  return /[ऀ-ॿ]/.test(text);
}

// Wishlist shortcut keywords (English + Hindi)
const WISHLIST_KEYWORDS = /^(wishlist|my wishlist|meri list|saved items|saved products|meri wishlist)$/i;

export async function processMessage(
  userId: string,
  userText: string
): Promise<string> {
  try {
    const client = await getMcpClient();
    const session = getSession(userId);

    // Detect and remember language preference
    if (containsHindi(userText)) setPreferredLanguage(userId, 'hi');

    // Wishlist shortcut — no LLM needed
    if (WISHLIST_KEYWORDS.test(userText.trim())) {
      const { formatWishlist } = await import('../whatsapp/messageFormatter.js');
      return formatWishlist(getWishlist(userId));
    }

    appendMessage(userId, { role: 'user', content: userText });

    // Build message history in OpenAI/Groq format
    const messages: Groq.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...session.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    // Agentic loop — bounded so a tool-happy model can't spin forever
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await getGroq().chat.completions.create({
        model: MODEL,
        messages,
        tools: groqTools,
        tool_choice: 'auto',
        max_tokens: 1024,
        temperature: 0.7,
      });

      const choice = response.choices[0];
      const assistantMessage = choice.message;

      // Append assistant turn to history
      messages.push(assistantMessage);

      // If no tool calls, we have the final answer
      if (
        choice.finish_reason === 'stop' ||
        !assistantMessage.tool_calls ||
        assistantMessage.tool_calls.length === 0
      ) {
        const text = assistantMessage.content?.trim() ?? '';
        appendMessage(userId, { role: 'assistant', content: text });
        return text || 'I encountered an issue. Please try again.';
      }

      // Execute each tool call via MCP
      for (const toolCall of assistantMessage.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          // malformed JSON args — skip
        }

        console.log(`[Agent] Tool call: ${toolCall.function.name}`, args);

        let resultText = '{}';
        try {
          const mcpResult = await client.callTool({
            name: toolCall.function.name,
            arguments: args,
          });

          const content = mcpResult.content as Array<{ type: string; text?: string }>;
          resultText =
            content
              .filter((c) => c.type === 'text' && typeof c.text === 'string')
              .map((c) => c.text as string)
              .join('\n') || '{}';

          // Cache search results for session context
          if (toolCall.function.name === 'search_products') {
            try {
              const parsed = JSON.parse(resultText);
              const allProducts: Product[] = [];
              for (const r of parsed.results ?? []) {
                allProducts.push(...(r.products ?? []));
              }
              saveSearchResults(userId, allProducts);
            } catch {
              // ignore JSON parse errors
            }
          }
        } catch (toolErr) {
          resultText = JSON.stringify({
            error: toolErr instanceof Error ? toolErr.message : 'Tool call failed',
          });
        }

        // Append tool result in Groq/OpenAI format
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: resultText,
        });
      }
    }

    // Tool-round budget exhausted — force a final answer without tools
    console.warn(`[Agent] Hit MAX_TOOL_ROUNDS (${MAX_TOOL_ROUNDS}) for ${userId} — forcing final answer`);
    const finalResponse = await getGroq().chat.completions.create({
      model: MODEL,
      messages,
      max_tokens: 1024,
      temperature: 0.7,
    });
    const finalText = finalResponse.choices[0]?.message?.content?.trim() ?? '';
    appendMessage(userId, { role: 'assistant', content: finalText });
    return finalText || 'I found some options but need you to narrow things down — could you rephrase your search?';
  } catch (err) {
    console.error('[Agent] processMessage error:', err);
    // If the MCP transport died, drop the client so the next message reconnects
    if (err instanceof Error && /clos|transport|EPIPE|ECONN|not connected/i.test(err.message)) {
      console.warn('[Agent] MCP connection appears dead — resetting client for reconnect');
      mcpClient = null;
    }
    return 'Sorry, I ran into a problem. Please try again in a moment.';
  }
}

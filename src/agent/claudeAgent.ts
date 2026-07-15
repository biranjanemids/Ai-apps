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

// Model to use — llama-3.3-70b-versatile has the best tool-calling support on Groq
// free tier. Override with GROQ_MODEL in .env without touching code.
const MODEL = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';

// When the primary model's daily token quota runs out (429), fall back to a
// smaller model — Groq tracks rate limits per model, so its quota is separate.
const FALLBACK_MODEL = process.env.GROQ_FALLBACK_MODEL ?? 'llama-3.1-8b-instant';

// Safety cap on tool-calling rounds per user message — prevents runaway loops
const MAX_TOOL_ROUNDS = 6;

// Groq's llama models occasionally emit tool calls in malformed formats like
// `<function=search_products {"query": ...} </function>` or
// `<function=get_product_details({"platform": ...})</function>` — Groq then
// 400s with code 'tool_use_failed' but includes the intended call in
// failed_generation. We salvage it (the args are usually valid JSON).
function salvageToolCall(failedGeneration: string): { name: string; args: string } | null {
  const nameMatch = failedGeneration.match(/<function=([a-zA-Z0-9_]+)/);
  const start = failedGeneration.indexOf('{');
  const end = failedGeneration.lastIndexOf('}');
  if (!nameMatch || start === -1 || end <= start) return null;
  const args = failedGeneration.slice(start, end + 1);
  try {
    JSON.parse(args);
    return { name: nameMatch[1], args };
  } catch {
    return null;
  }
}

type GroqChoice = Groq.Chat.Completions.ChatCompletion.Choice;

async function chatWithToolRetry(
  messages: Groq.Chat.ChatCompletionMessageParam[],
  tools: Groq.Chat.ChatCompletionTool[]
): Promise<GroqChoice> {
  let lastErr: unknown;
  let model = MODEL;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await getGroq().chat.completions.create({
        model,
        messages,
        tools,
        tool_choice: 'auto',
        max_tokens: 1024,
        // Lower temperature on retries — malformed tool calls are more likely when sampling hot
        temperature: attempt === 1 ? 0.6 : 0.2,
      });
      return response.choices[0];
    } catch (err) {
      // Daily quota exhausted on the primary model → switch to the fallback
      // model, which has its own separate quota
      if ((err as { status?: number })?.status === 429 && model !== FALLBACK_MODEL) {
        console.warn(`[Agent] ${model} rate-limited — falling back to ${FALLBACK_MODEL}`);
        model = FALLBACK_MODEL;
        lastErr = err;
        continue;
      }

      const inner = (err as { error?: { error?: { code?: string; failed_generation?: string } } })
        ?.error?.error;
      if (inner?.code !== 'tool_use_failed') throw err;
      lastErr = err;

      // Salvage: extract the tool call the model intended and synthesize the turn
      const salvaged = salvageToolCall(inner.failed_generation ?? '');
      if (salvaged) {
        console.warn(`[Agent] Salvaged malformed tool call for ${salvaged.name}`);
        return {
          index: 0,
          finish_reason: 'tool_calls',
          logprobs: null,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: `salvaged_${attempt}_${salvaged.name}`,
                type: 'function',
                function: { name: salvaged.name, arguments: salvaged.args },
              },
            ],
          },
        } as unknown as GroqChoice;
      }
      console.warn(`[Agent] Groq tool_use_failed (attempt ${attempt}/3) — retrying`);
    }
  }
  throw lastErr;
}

const SYSTEM_PROMPT = `You are ShopBot, a smart WhatsApp shopping assistant that finds, compares, and helps buy products across 8 Indian platforms: Amazon, Flipkart, Myntra, Meesho, Nykaa, Ajio, Zepto, and Instamart.

## Language
- Detect if the user writes in Hindi (Devanagari or Hinglish). If so, respond in simple Hindi/Hinglish. Otherwise respond in English.
- Hindi greeting: "नमस्ते! मैं ShopBot हूं 🛒 आप क्या खरीदना चाहते हैं?"
- English greeting: "Hi! I'm ShopBot 🛒 What are you looking to buy today?"

## Data Integrity (CRITICAL — never break these)
- NEVER invent, imagine, or recall products, prices, or ratings from memory
- Every product you mention MUST come from a tool result in THIS conversation
- Any new product request, or a changed budget/category/size → call search_products again FIRST — do not answer from earlier results
- If a tool returned nothing, say so honestly and suggest broadening the search
- NEVER write "<function=...>" or any tool-call syntax as text in a reply — actually call the tool

## Conversation Flow
1. Greet and ask what product they want
2. Ask for budget range in ₹ (e.g. "₹500 to ₹2000") if not given
3. Call search_products — always search all 8 platforms unless they specify
4. IMPORTANT: ALWAYS extract the budget from the message into minPrice/maxPrice:
   "under 3000" → maxPrice: 3000 · "above 500" → minPrice: 500 · "500 to 2000" → both
5. CRITICAL: After search_products returns, DO NOT list or describe the products yourself.
   The system automatically sends the user a formatted result list and product cards with
   Buy buttons. Your reply must be only 1-2 short lines: a recommendation (e.g. which pick
   is best value and why) + a nudge like "Tap *Buy Now* on a card below 👇"
6. If compare → call compare_products and highlight price savings
7. If buy → call get_buy_link and share checkout URL
8. If wishlist → confirm "Saved ❤️ to your wishlist! Type *wishlist* to see all saved items"

## Platform Guide (use this to recommend the right platform)
- 🛒 Amazon — electronics, gadgets, books, wide selection
- 🛍 Flipkart — smartphones, appliances, exclusive deals
- 👗 Myntra — fashion, premium clothing, footwear
- 🏷️ Meesho — budget shopping, ethnic wear, home decor under ₹500
- 💄 Nykaa — beauty, skincare, haircare, wellness
- 👔 Ajio — branded fashion, Reliance exclusives, ethnic sets
- ⚡ Zepto — groceries & daily essentials in 10 minutes
- 🥦 Instamart — Swiggy quick-commerce: groceries, household, snacks in 15 minutes

## Key Differentiators to Mention
- "I compare prices across 8 platforms — Amazon, Flipkart, Myntra, Meesho, Nykaa, Ajio, Zepto & Instamart"
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
- Use emojis: 🛒 Amazon · 🛍 Flipkart · 👗 Myntra · 🏷️ Meesho · 💄 Nykaa · 👔 Ajio · ⚡ Zepto · 🥦 Instamart · 🔥 deals · ⭐ ratings
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
- Category routing: beauty → Nykaa, budget → Meesho, fashion → Ajio/Myntra, electronics → Amazon/Flipkart, groceries/essentials → Zepto/Instamart
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

// Search outcome captured from a search_products tool call, so the webhook can
// render results deterministically (formatted list + product cards) instead of
// relying on the LLM to write them out.
export interface SearchOutcome {
  results: Array<{ platform: string; products: Product[]; error?: string }>;
  cheapestPlatform?: string;
  bestValuePlatform?: string;
}

export interface AgentReply {
  text: string;
  search?: SearchOutcome;
}

export async function processMessage(
  userId: string,
  userText: string
): Promise<AgentReply> {
  let lastSearch: SearchOutcome | undefined;
  try {
    const client = await getMcpClient();
    const session = getSession(userId);

    // Detect and remember language preference
    if (containsHindi(userText)) setPreferredLanguage(userId, 'hi');

    // Wishlist shortcut — no LLM needed
    if (WISHLIST_KEYWORDS.test(userText.trim())) {
      const { formatWishlist } = await import('../whatsapp/messageFormatter.js');
      return { text: formatWishlist(getWishlist(userId)) };
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
      const choice = await chatWithToolRetry(messages, groqTools);
      let assistantMessage = choice.message;

      // The model sometimes writes a pseudo tool call as plain TEXT instead of
      // a real tool call — convert it into a real one so it actually executes
      if (
        (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) &&
        assistantMessage.content?.includes('<function=')
      ) {
        const leaked = salvageToolCall(assistantMessage.content);
        if (leaked) {
          console.warn(`[Agent] Converting leaked text tool call to real call: ${leaked.name}`);
          assistantMessage = {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: `leaked_${round}_${leaked.name}`,
                type: 'function',
                function: { name: leaked.name, arguments: leaked.args },
              },
            ],
          } as typeof assistantMessage;
        }
      }

      // Append assistant turn to history
      messages.push(assistantMessage);

      // If no tool calls, we have the final answer
      if (
        choice.finish_reason === 'stop' ||
        !assistantMessage.tool_calls ||
        assistantMessage.tool_calls.length === 0
      ) {
        // Scrub any remaining tool-call syntax the model leaked into its text
        // (multiple pseudo calls in one message can't be converted above)
        const text = (assistantMessage.content?.trim() ?? '').replace(
          /<function=[^{<]*\{[\s\S]*?\}(?:\s*\))?(?:\s*<\/function>)?/g,
          '_(tap Buy Now on the product card)_'
        );
        appendMessage(userId, { role: 'assistant', content: text });
        return {
          text: text || (lastSearch ? '' : 'I encountered an issue. Please try again.'),
          search: lastSearch,
        };
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

          // Cache search results for session context and capture the outcome
          // so the webhook can render it deterministically
          if (toolCall.function.name === 'search_products') {
            try {
              const parsed = JSON.parse(resultText);
              const allProducts: Product[] = [];
              for (const r of parsed.results ?? []) {
                allProducts.push(...(r.products ?? []));
              }
              saveSearchResults(userId, allProducts);
              if (allProducts.length > 0) {
                lastSearch = {
                  results: parsed.results ?? [],
                  cheapestPlatform: parsed.cheapestPlatform,
                  bestValuePlatform: parsed.bestValuePlatform,
                };
              }
              // Token diet: the LLM only needs compact facts to reason with —
              // URLs/images/specs are rendered by the webhook, not the model.
              // This cuts search-turn token usage by roughly half.
              resultText = JSON.stringify({
                cheapestPlatform: parsed.cheapestPlatform,
                bestValuePlatform: parsed.bestValuePlatform,
                results: (parsed.results ?? []).map(
                  (r: { platform: string; products?: Product[] }) => ({
                    platform: r.platform,
                    products: (r.products ?? []).map((p) => ({
                      id: p.id,
                      title: p.title,
                      price: p.price,
                      rating: p.rating,
                    })),
                  })
                ),
              });
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
    return {
      text: finalText || (lastSearch ? '' : 'I found some options but need you to narrow things down — could you rephrase your search?'),
      search: lastSearch,
    };
  } catch (err) {
    console.error('[Agent] processMessage error:', err);

    // Daily AI quota exhausted on all models — tell the user when to retry
    if ((err as { status?: number })?.status === 429) {
      const waitMatch = err instanceof Error ? err.message.match(/try again in (\d+)m/i) : null;
      const wait = waitMatch ? `about ${waitMatch[1]} minutes` : 'a little while';
      return {
        text: `⏳ I've hit today's free AI usage limit. Please try again in ${wait} 🙏`,
        search: lastSearch,
      };
    }

    // If the MCP transport died, drop the client so the next message reconnects
    if (err instanceof Error && /clos|transport|EPIPE|ECONN|not connected/i.test(err.message)) {
      console.warn('[Agent] MCP connection appears dead — resetting client for reconnect');
      mcpClient = null;
    }
    return { text: 'Sorry, I ran into a problem. Please try again in a moment.', search: lastSearch };
  }
}

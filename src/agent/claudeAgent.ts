import Groq from 'groq-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getSession,
  appendMessage,
  saveSearchResults,
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

const SYSTEM_PROMPT = `You are a helpful WhatsApp shopping assistant that helps users find, compare, and buy products across Amazon, Flipkart, and Myntra in India.

Your conversational flow:
1. Greet the user and ask what product they're looking for
2. Ask for their budget range (in INR ₹)
3. Ask for any brand or platform preference (or "any")
4. Search for products using the search_products tool
5. Present results in a numbered, easy-to-read format grouped by platform
6. Ask if they want to compare specific products or buy one
7. If compare: use compare_products tool and show the differences clearly
8. If buy: use get_buy_link tool, then share the checkout URL and tell the user to tap "Buy Now" or the link to complete purchase on the platform

Buy flow guidance:
- When a user says "buy 2" or "I want to buy product 3", call get_buy_link with the product id and platform
- After getting the checkout URL, respond with the URL and encourage them to complete checkout on the platform
- The system will automatically show interactive buttons for Buy Now / Compare / Details after search results
- If a user taps a Buy Now button, the system handles address/phone collection automatically — you do NOT need to ask for these
- For buy requests made via text, just provide the checkout link clearly

Guidelines:
- Keep responses concise — this is WhatsApp chat, not a webpage
- Use emoji sparingly but helpfully (🛒 Amazon, 🛍 Flipkart, 👗 Myntra)
- Always number products sequentially so users can say "compare 1 and 3" or "buy 2"
- Format prices as ₹X,XXX
- Be friendly and helpful, like a knowledgeable shopping friend
- Never ask for personal info (address, phone) — the system handles that via interactive buttons`;

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

export async function processMessage(
  userId: string,
  userText: string
): Promise<string> {
  try {
    const client = await getMcpClient();
    const session = getSession(userId);

    appendMessage(userId, { role: 'user', content: userText });

    // Build message history in OpenAI/Groq format
    const messages: Groq.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...session.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    // Agentic loop — keep running until the model stops calling tools
    while (true) {
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
  } catch (err) {
    console.error('[Agent] processMessage error:', err);
    return 'Sorry, I ran into a problem. Please try again in a moment.';
  }
}

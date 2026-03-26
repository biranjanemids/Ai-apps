import Anthropic from '@anthropic-ai/sdk';
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

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a helpful WhatsApp shopping assistant that helps users find and compare products across Amazon, Flipkart, and Myntra.

Your conversational flow:
1. Greet the user and ask what product they're looking for
2. Ask for their budget range (in INR)
3. Ask for any brand or platform preference (or "any")
4. Search for products using the search_products tool
5. Present results in a numbered, easy-to-read format grouped by platform
6. Ask if they want to compare specific products or buy one
7. If compare: use compare_products tool and show differences
8. If buy: use get_buy_link tool and provide the purchase URL

Guidelines:
- Keep responses concise — this is WhatsApp, not a webpage
- Use emoji sparingly but helpfully (🛒 Amazon, 🛍 Flipkart, 👗 Myntra)
- Always number products sequentially across platforms so users can easily refer to them
- Format prices as ₹X,XXX
- After showing search results, store them mentally so users can say "compare 1 and 3" or "buy 2"
- If a platform returns no results, mention it briefly and continue
- Be friendly and helpful, like a knowledgeable shopping friend`;

let mcpClient: Client | null = null;
let mcpTools: Anthropic.Messages.Tool[] = [];

async function getMcpClient(): Promise<Client> {
  if (mcpClient) return mcpClient;

  const serverPath = path.resolve(__dirname, '../../dist/mcp/server.js');
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
      RAPIDAPI_KEY: process.env.RAPIDAPI_KEY ?? '',
    },
  });

  const client = new Client({ name: 'shopping-whatsapp-agent', version: '1.0.0' }, {});
  await client.connect(transport);

  const { tools } = await client.listTools();
  mcpTools = tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.inputSchema as Anthropic.Messages.Tool['input_schema'],
  }));

  mcpClient = client;
  console.log(`[Agent] MCP client connected, ${mcpTools.length} tools available`);
  return client;
}

export async function processMessage(
  userId: string,
  userText: string
): Promise<string> {
  try {
    const client = await getMcpClient();
    const session = getSession(userId);

    appendMessage(userId, { role: 'user', content: userText });

    const messages: Anthropic.Messages.MessageParam[] = session.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    let response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: mcpTools,
      messages,
    });

    // Agentic loop: handle tool calls until we get a final text response
    while (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
      );

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        console.log(`[Agent] Calling MCP tool: ${toolUse.name}`, toolUse.input);
        try {
          const result = await client.callTool({
            name: toolUse.name,
            arguments: toolUse.input as Record<string, unknown>,
          });

          const content = result.content as Array<{ type: string; text?: string }>;
          const resultText =
            content
              .filter((c) => c.type === 'text' && typeof c.text === 'string')
              .map((c) => c.text as string)
              .join('\n') || '{}';

          // Cache search results so we can reference them by index
          if (toolUse.name === 'search_products') {
            try {
              const parsed = JSON.parse(resultText);
              const allProducts: Product[] = [];
              for (const r of parsed.results ?? []) {
                allProducts.push(...(r.products ?? []));
              }
              saveSearchResults(userId, allProducts);
            } catch {
              // ignore parse errors
            }
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: resultText,
          });
        } catch (toolErr) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              error: toolErr instanceof Error ? toolErr.message : 'Tool call failed',
            }),
            is_error: true,
          });
        }
      }

      // Append assistant turn + tool results and continue
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: mcpTools,
        messages,
      });
    }

    // Extract final text response
    const assistantText = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    appendMessage(userId, { role: 'assistant', content: assistantText });
    return assistantText || 'I encountered an issue. Please try again.';
  } catch (err) {
    console.error('[Agent] processMessage error:', err);
    return 'Sorry, I ran into a problem. Please try again in a moment.';
  }
}

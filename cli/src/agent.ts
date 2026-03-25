import { ApiClient, type Message, type ToolCall } from './client.js'
import { TOOL_DEFINITIONS, executeTool, type ToolResult } from './tools/index.js'
import { buildContext, relevantFiles, type ProjectContext } from './context/indexer.js'

const MAX_TOOL_ROUNDS = 12

export type AgentEvent =
  | { type: 'token';       content: string }
  | { type: 'tool_start';  name: string; args: Record<string, any> }
  | { type: 'tool_end';    name: string; result: ToolResult }
  | { type: 'error';       message: string }
  | { type: 'done' }

const SYSTEM_PROMPT = (tree: string, fileSnippets: string) => `\
You are an expert coding assistant running in a terminal. You help users understand, \
write, and refactor code in their project.

## Project structure
\`\`\`
${tree}
\`\`\`

${fileSnippets}

## Guidelines
- Always read a file before editing it.
- Prefer edit_file over write_file for targeted changes.
- Use run_command to test your changes (e.g. npm test, tsc).
- Keep responses concise — the user is a developer.
- If unsure about a file's content, read it first.
`

export class Agent {
  private ctx: ProjectContext
  private history: Message[] = []
  private client: ApiClient

  constructor(
    private cwd:   string,
    private model: string,
    serverUrl:     string,
    apiKey:        string,
  ) {
    this.client = new ApiClient(serverUrl, apiKey)
    this.ctx    = buildContext(cwd)
  }

  setModel(model: string) {
    this.model = model
  }

  clearHistory() {
    this.history = []
  }

  getContext() {
    return this.ctx
  }

  refreshContext() {
    this.ctx = buildContext(this.cwd)
  }

  async *run(userMessage: string): AsyncGenerator<AgentEvent> {
    // Build system prompt with relevant file context
    const relevant = relevantFiles(this.ctx, userMessage)
    const snippets = relevant.size
      ? [...relevant.entries()]
          .map(([path, content]) => `## ${path}\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\``)
          .join('\n\n')
      : ''

    const system: Message = {
      role:    'system',
      content: SYSTEM_PROMPT(this.ctx.tree, snippets),
    }

    this.history.push({ role: 'user', content: userMessage })

    let rounds = 0

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++

      const messages: Message[] = [system, ...this.history]

      // Stream text responses, but use non-streaming when tools are present
      // (easier to parse tool_calls from a single response)
      let assistantContent = ''
      let toolCalls: ToolCall[] = []

      try {
        // First pass: stream tokens to get text response
        // If the model decides to use tools, we'll get them in a second non-stream call
        for await (const { delta, done } of this.client.chatCompleteStream({
          model:    this.model,
          messages,
          tools:    TOOL_DEFINITIONS as any,
          stream:   true,
        })) {
          if (done) break
          assistantContent += delta
          yield { type: 'token', content: delta }
        }

        // Check if the complete response has tool calls by doing a non-stream pass
        // only if the model returned an empty or suspiciously short content
        if (!assistantContent.trim()) {
          const msg = await this.client.chatComplete({
            model:    this.model,
            messages,
            tools:    TOOL_DEFINITIONS as any,
          })
          assistantContent = msg.content ?? ''
          toolCalls        = msg.tool_calls ?? []
          if (assistantContent) yield { type: 'token', content: assistantContent }
        }
      } catch (err: any) {
        yield { type: 'error', message: err.message }
        break
      }

      this.history.push({
        role:        'assistant',
        content:     assistantContent || null,
        tool_calls:  toolCalls.length ? toolCalls : undefined,
      })

      // No tool calls — we're done
      if (!toolCalls.length) break

      // Execute each tool call
      for (const tc of toolCalls) {
        let args: Record<string, any> = {}
        try { args = JSON.parse(tc.function.arguments) } catch {}

        yield { type: 'tool_start', name: tc.function.name, args }

        const result = executeTool(tc.function.name, args, this.cwd)

        yield { type: 'tool_end', name: tc.function.name, result }

        this.history.push({
          role:         'tool',
          tool_call_id: tc.id,
          name:         tc.function.name,
          content:      result.content,
        })
      }

      // Refresh context after file changes
      this.refreshContext()
    }

    yield { type: 'done' }
  }
}

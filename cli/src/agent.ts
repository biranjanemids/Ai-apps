import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join, resolve }  from 'path'
import { homedir }        from 'os'
import { createHash }     from 'crypto'
import { ApiClient, type Message, type ToolCall, type Usage } from './client.js'
import { TOOL_DEFINITIONS, executeTool, type ToolResult }     from './tools/index.js'
import { buildContext, relevantFiles, type ProjectContext }    from './context/indexer.js'

const MAX_TOOL_ROUNDS   = 20
const SESSIONS_DIR      = join(homedir(), '.ai-code', 'sessions')

// ── Agent events emitted to the TUI ──────────────────────────────────────────

export type AgentEvent =
  | { type: 'token';       content: string }
  | { type: 'tool_start';  name: string; args: Record<string, any> }
  | { type: 'tool_end';    name: string; result: ToolResult }
  | { type: 'usage';       tokens: number }
  | { type: 'error';       message: string }
  | { type: 'done' }

// ── System prompt (Claude Code / Windsurf style) ──────────────────────────────

function buildSystemPrompt(tree: string, fileSnippets: string): string {
  return `\
You are an expert AI coding assistant operating in a terminal. You solve coding tasks \
by using tools iteratively. Think step by step before acting.

## Identity & Role
- You are running inside a developer's project directory
- You have full access to read, write, and execute within the project
- You produce clean, idiomatic code matching the project's existing style and conventions

## Project Structure
\`\`\`
${tree}
\`\`\`

${fileSnippets ? `## Relevant Files\n${fileSnippets}\n` : ''}

## Tool Strategy
- ALWAYS read a file before editing it — never assume its current content
- Use \`edit_file\` for targeted changes; \`write_file\` only for new files or full rewrites
- Use \`search_codebase\` to find where symbols/functions are defined before editing them
- Run \`git_status\` before and after changes to understand what changed
- Run type-checkers/linters/tests after changes to verify correctness (e.g. \`npx tsc --noEmit\`)
- When multiple tool calls are independent of each other, call them together — they run in parallel

## Coding Philosophy
- Match existing code style: indentation, naming conventions, file structure, import patterns
- Don't add features or scope beyond what was asked
- Don't add comments unless the logic is genuinely non-obvious
- Don't break existing tests, APIs, or interfaces

## When to Stop and Ask
- Before large refactors that touch many files
- When requirements are genuinely ambiguous
- Before deleting files, force-pushing git, or other destructive operations

## Response Format
- Lead with action, not preamble
- Be concise — the user is a developer
- After making file edits, briefly summarise what changed and why
- Use tool calls rather than asking the user to run commands themselves
`
}

// ── Agent ─────────────────────────────────────────────────────────────────────

export class Agent {
  private ctx:         ProjectContext
  private history:     Message[]   = []
  private totalTokens: number      = 0
  private client:      ApiClient
  private sessionPath: string

  constructor(
    private cwd:   string,
    private model: string,
    serverUrl:     string,
    apiKey:        string,
  ) {
    this.client      = new ApiClient(serverUrl, apiKey)
    this.ctx         = buildContext(cwd)
    this.sessionPath = this.resolveSessionPath()
    mkdirSync(SESSIONS_DIR, { recursive: true })
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  setModel(model: string)  { this.model = model }
  clearHistory()           { this.history = []; this.totalTokens = 0 }
  getContext()             { return this.ctx }
  getTotalTokens()         { return this.totalTokens }
  refreshContext()         { this.ctx = buildContext(this.cwd) }

  saveSession(): string {
    const data = JSON.stringify({ cwd: this.cwd, model: this.model, history: this.history }, null, 2)
    writeFileSync(this.sessionPath, data, 'utf-8')
    return this.sessionPath
  }

  loadSession(): boolean {
    if (!existsSync(this.sessionPath)) return false
    try {
      const data     = JSON.parse(readFileSync(this.sessionPath, 'utf-8'))
      this.history   = data.history ?? []
      this.model     = data.model   ?? this.model
      return true
    } catch {
      return false
    }
  }

  listSessions(): string[] {
    if (!existsSync(SESSIONS_DIR)) return []
    return readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => join(SESSIONS_DIR, f))
  }

  // ── Main agentic loop ───────────────────────────────────────────────────────

  async *run(userMessage: string): AsyncGenerator<AgentEvent> {
    // Build system prompt with content-based relevant file context
    const relevant   = relevantFiles(this.ctx, userMessage)
    const snippets   = [...relevant.entries()]
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\``)
      .join('\n\n')

    const system: Message = {
      role:    'system',
      content: buildSystemPrompt(this.ctx.tree, snippets),
    }

    this.history.push({ role: 'user', content: userMessage })

    let rounds = 0

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++

      const messages = [system, ...this.history]

      // ── Single streaming pass: accumulate text AND tool_call deltas ─────────
      let assistantText = ''
      const toolCallMap = new Map<number, { id: string; name: string; args: string }>()

      try {
        for await (const event of this.client.chatCompleteStream({
          model:    this.model,
          messages,
          tools:    TOOL_DEFINITIONS as any,
          stream:   true,
        })) {
          if (event.type === 'text') {
            assistantText += event.delta
            yield { type: 'token', content: event.delta }

          } else if (event.type === 'tool_call') {
            const existing = toolCallMap.get(event.index) ?? { id: '', name: '', args: '' }
            toolCallMap.set(event.index, {
              id:   event.id   ?? existing.id,
              name: event.name ?? existing.name,
              args: existing.args + event.argsDelta,
            })

          } else if (event.type === 'done') {
            if (event.usage) {
              this.totalTokens += event.usage.total_tokens
              yield { type: 'usage', tokens: this.totalTokens }
            }
          }
        }
      } catch (err: any) {
        yield { type: 'error', message: err.message }
        break
      }

      // Assemble tool calls from accumulated deltas
      const toolCalls: ToolCall[] = [...toolCallMap.entries()]
        .sort(([a], [b]) => a - b)
        .filter(([, tc]) => tc.name)
        .map(([, tc]) => ({
          id:       tc.id || `call_${Math.random().toString(36).slice(2)}`,
          type:     'function' as const,
          function: { name: tc.name, arguments: tc.args },
        }))

      // Add assistant message to history
      this.history.push({
        role:       'assistant',
        content:    assistantText || null,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      })

      // No tool calls — final answer, done
      if (!toolCalls.length) break

      // ── Parallel tool execution ─────────────────────────────────────────────
      // 1. Announce all tool starts simultaneously
      const parsedArgs = toolCalls.map(tc => {
        try { return JSON.parse(tc.function.arguments) } catch { return {} }
      })
      for (let i = 0; i < toolCalls.length; i++) {
        yield { type: 'tool_start', name: toolCalls[i].function.name, args: parsedArgs[i] }
      }

      // 2. Execute all tools in parallel
      const results = await Promise.allSettled(
        toolCalls.map((tc, i) => executeTool(tc.function.name, parsedArgs[i], this.cwd))
      )

      // 3. Collect results, yield tool_end events, add tool messages to history
      for (let i = 0; i < toolCalls.length; i++) {
        const tc     = toolCalls[i]
        const settled = results[i]
        const result: ToolResult = settled.status === 'fulfilled'
          ? settled.value
          : { content: `Tool error: ${(settled as PromiseRejectedResult).reason?.message ?? 'unknown'}` }

        yield { type: 'tool_end', name: tc.function.name, result }

        this.history.push({
          role:         'tool',
          tool_call_id: tc.id,
          name:         tc.function.name,
          content:      result.content,
        })
      }

      // Refresh context after any file system changes
      this.refreshContext()
    }

    // Auto-save session after each completed turn
    try { this.saveSession() } catch {}

    yield { type: 'done' }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private resolveSessionPath(): string {
    const hash = createHash('sha1').update(resolve(this.cwd)).digest('hex').slice(0, 12)
    return join(SESSIONS_DIR, `${hash}.json`)
  }
}

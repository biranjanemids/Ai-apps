// ── Types ─────────────────────────────────────────────────────────────────────

export interface Message {
  role:          'system' | 'user' | 'assistant' | 'tool'
  content:       string | null
  tool_calls?:   ToolCall[]
  tool_call_id?: string
  name?:         string
}

export interface ToolCall {
  id:       string
  type:     'function'
  function: { name: string; arguments: string }
}

export interface ChatRequest {
  model:        string
  messages:     Message[]
  stream?:      boolean
  tools?:       any[]
  temperature?: number
  max_tokens?:  number
}

export interface Usage {
  prompt_tokens:     number
  completion_tokens: number
  total_tokens:      number
}

// StreamEvent — emitted by chatCompleteStream
export type StreamEvent =
  | { type: 'text';      delta: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; argsDelta: string }
  | { type: 'done';      usage?: Usage }

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const NO_RETRY_STATUS  = new Set([400, 401, 403, 404, 422])

// ── ApiClient ─────────────────────────────────────────────────────────────────

export class ApiClient {
  lastUsage: Usage | null = null

  constructor(
    private baseUrl: string,
    private apiKey:  string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`
    return h
  }

  // Retry wrapper — retries on network errors and retryable HTTP status codes
  private async withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
    let lastErr: any
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn()
      } catch (err: any) {
        lastErr = err
        const status = err?.status as number | undefined
        // Don't retry client errors
        if (status !== undefined && NO_RETRY_STATUS.has(status)) throw err
        // Don't retry on final attempt
        if (attempt === maxAttempts - 1) throw err
        // Exponential backoff: 1s, 2s, 4s
        await sleep(1000 * 2 ** attempt)
      }
    }
    throw lastErr
  }

  private async fetchWithStatus(url: string, init: RequestInit): Promise<Response> {
    const res = await fetch(url, init)
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } }))
      const err  = new Error((body as any).error?.message ?? res.statusText) as any
      err.status = res.status
      throw err
    }
    return res
  }

  // Non-streaming chat — returns full assistant message with optional tool calls
  async chatComplete(req: ChatRequest): Promise<Message> {
    return this.withRetry(async () => {
      const res  = await this.fetchWithStatus(`${this.baseUrl}/v1/chat/completions`, {
        method:  'POST',
        headers: this.headers(),
        body:    JSON.stringify({ ...req, stream: false }),
      })
      const data: any = await res.json()
      if (data.usage) this.lastUsage = data.usage
      return data.choices[0].message as Message
    })
  }

  // Streaming chat — yields text deltas AND tool_call deltas from a single SSE stream
  async *chatCompleteStream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const res = await this.withRetry(() =>
      this.fetchWithStatus(`${this.baseUrl}/v1/chat/completions`, {
        method:  'POST',
        headers: this.headers(),
        body:    JSON.stringify({ ...req, stream: true }),
      })
    )

    const reader  = res.body!.getReader()
    const decoder = new TextDecoder()
    let   buffer  = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data: ')) continue
        const raw = trimmed.slice(6)
        if (raw === '[DONE]') { yield { type: 'done' }; return }

        let chunk: any
        try { chunk = JSON.parse(raw) } catch { continue }

        // Parse usage if present (some providers include it in final chunk)
        if (chunk.usage) {
          this.lastUsage = chunk.usage
          yield { type: 'done', usage: chunk.usage }
          return
        }

        const delta = chunk.choices?.[0]?.delta
        if (!delta) continue

        // Text delta
        if (typeof delta.content === 'string' && delta.content) {
          yield { type: 'text', delta: delta.content }
        }

        // Tool call deltas — accumulate by index
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            yield {
              type:      'tool_call',
              index:     tc.index ?? 0,
              id:        tc.id,
              name:      tc.function?.name,
              argsDelta: tc.function?.arguments ?? '',
            }
          }
        }
      }
    }
    yield { type: 'done' }
  }

  async listModels(): Promise<string[]> {
    try {
      const res  = await fetch(`${this.baseUrl}/v1/models`, { headers: this.headers() })
      const data: any = await res.json()
      return (data.data as any[]).map((m: any) => m.id)
    } catch {
      return []
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`)
      return res.ok
    } catch {
      return false
    }
  }
}

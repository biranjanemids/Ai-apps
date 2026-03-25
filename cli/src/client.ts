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
  model:       string
  messages:    Message[]
  stream?:     boolean
  tools?:      any[]
  temperature?: number
  max_tokens?:  number
}

export class ApiClient {
  constructor(
    private baseUrl: string,
    private apiKey:  string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`
    return h
  }

  async chatComplete(req: ChatRequest): Promise<Message> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method:  'POST',
      headers: this.headers(),
      body:    JSON.stringify({ ...req, stream: false }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } }))
      throw new Error((body as any).error?.message ?? res.statusText)
    }
    const data: any = await res.json()
    return data.choices[0].message as Message
  }

  async *chatCompleteStream(req: ChatRequest): AsyncGenerator<{ delta: string; done: boolean }> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method:  'POST',
      headers: this.headers(),
      body:    JSON.stringify({ ...req, stream: true }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } }))
      throw new Error((body as any).error?.message ?? res.statusText)
    }

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
        const data = trimmed.slice(6)
        if (data === '[DONE]') { yield { delta: '', done: true }; return }
        try {
          const chunk = JSON.parse(data)
          const delta = chunk.choices?.[0]?.delta?.content
          if (delta) yield { delta, done: false }
        } catch {}
      }
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res  = await fetch(`${this.baseUrl}/v1/models`, { headers: this.headers() })
      const data: any = await res.json()
      return (data.data as any[]).map(m => m.id)
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

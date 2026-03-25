import { Ollama } from 'ollama'
import { randomUUID } from 'crypto'
import type { BaseProvider } from './base.js'
import type { ChatCompletionRequest, ChatCompletionResponse, ModelObject } from '../schemas/openai.js'

export class OllamaProvider implements BaseProvider {
  readonly name = 'ollama'
  private client: Ollama

  constructor(host: string) {
    this.client = new Ollama({ host })
  }

  async chatComplete(req: ChatCompletionRequest, upstream: string): Promise<ChatCompletionResponse> {
    const res = await this.client.chat({
      model:    upstream,
      messages: req.messages.map(m => ({
        role:    m.role as 'user' | 'assistant' | 'system',
        content: (m.content as string) ?? '',
      })),
      options: {
        temperature: req.temperature,
        num_predict: req.max_tokens,
      },
    })

    return {
      id:      `chatcmpl-${randomUUID()}`,
      object:  'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model:   upstream,
      choices: [{
        index:         0,
        message:       { role: 'assistant', content: res.message.content },
        finish_reason: res.done ? 'stop' : null,
      }],
      usage: {
        prompt_tokens:     res.prompt_eval_count     ?? 0,
        completion_tokens: res.eval_count            ?? 0,
        total_tokens:      (res.prompt_eval_count ?? 0) + (res.eval_count ?? 0),
      },
    }
  }

  async *chatCompleteStream(req: ChatCompletionRequest, upstream: string): AsyncGenerator<string> {
    const stream = await this.client.chat({
      model:    upstream,
      messages: req.messages.map(m => ({
        role:    m.role as 'user' | 'assistant' | 'system',
        content: (m.content as string) ?? '',
      })),
      stream:  true,
      options: {
        temperature: req.temperature,
        num_predict: req.max_tokens,
      },
    })

    const id      = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)

    for await (const part of stream) {
      const data: any = {
        id, object: 'chat.completion.chunk', created, model: upstream,
        choices: [{
          index:         0,
          delta:         { content: part.message.content },
          finish_reason: part.done ? 'stop' : null,
        }],
      }
      yield `data: ${JSON.stringify(data)}\n\n`
    }
  }

  async listModels(): Promise<ModelObject[]> {
    const list = await this.client.list()
    return list.models.map(m => ({
      id:       m.name,
      object:   'model' as const,
      created:  Math.floor(new Date(m.modified_at).getTime() / 1000),
      owned_by: 'ollama',
    }))
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.list()
      return true
    } catch {
      return false
    }
  }
}

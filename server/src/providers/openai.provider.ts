import OpenAI from 'openai'
import { randomUUID } from 'crypto'
import type { BaseProvider } from './base.js'
import type { ChatCompletionRequest, ChatCompletionResponse, ModelObject } from '../schemas/openai.js'

export class OpenAIProvider implements BaseProvider {
  readonly name = 'openai'
  protected client: OpenAI

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })
  }

  async chatComplete(req: ChatCompletionRequest, upstream: string): Promise<ChatCompletionResponse> {
    const res = await this.client.chat.completions.create({
      ...(req as any),
      model:  upstream,
      stream: false,
    })
    return res as unknown as ChatCompletionResponse
  }

  async *chatCompleteStream(req: ChatCompletionRequest, upstream: string): AsyncGenerator<string> {
    const stream = await this.client.chat.completions.create({
      ...(req as any),
      model:  upstream,
      stream: true,
    })
    for await (const chunk of stream) {
      yield `data: ${JSON.stringify(chunk)}\n\n`
    }
  }

  async listModels(): Promise<ModelObject[]> {
    const res = await this.client.models.list()
    return res.data.map(m => ({
      id:       m.id,
      object:   'model' as const,
      created:  m.created,
      owned_by: m.owned_by,
    }))
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.models.list()
      return true
    } catch {
      return false
    }
  }
}

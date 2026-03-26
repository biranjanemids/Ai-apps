import { randomUUID } from 'crypto'
import type { BaseProvider } from './base.js'
import type { ChatCompletionRequest, ChatCompletionResponse, ModelObject } from '../schemas/openai.js'

/**
 * Mock provider — no API key required.
 * Deterministic responses for testing and CI without consuming real API credits.
 */
export class MockProvider implements BaseProvider {
  readonly name = 'mock'

  async chatComplete(req: ChatCompletionRequest, _upstream: string): Promise<ChatCompletionResponse> {
    const last    = req.messages.at(-1)
    const content = `[mock] Echo: "${last?.content ?? ''}"`

    return {
      id:      `chatcmpl-mock-${randomUUID()}`,
      object:  'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model:   'mock/echo',
      choices: [{
        index:         0,
        message:       { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }
  }

  async *chatCompleteStream(req: ChatCompletionRequest, _upstream: string): AsyncGenerator<string> {
    const last   = req.messages.at(-1)
    const words  = `[mock] Echo: "${last?.content ?? ''}"`.split(' ')
    const id     = `chatcmpl-mock-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)

    for (const word of words) {
      const chunk = {
        id,
        object:  'chat.completion.chunk',
        created,
        model:   'mock/echo',
        choices: [{ index: 0, delta: { content: word + ' ' }, finish_reason: null }],
      }
      yield `data: ${JSON.stringify(chunk)}\n\n`
      // Small delay to simulate real streaming
      await new Promise(r => setTimeout(r, 30))
    }

    // Final chunk
    const done = {
      id, object: 'chat.completion.chunk', created, model: 'mock/echo',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }
    yield `data: ${JSON.stringify(done)}\n\n`
  }

  async listModels(): Promise<ModelObject[]> {
    return [{ id: 'mock/echo', object: 'model', created: 0, owned_by: 'mock' }]
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

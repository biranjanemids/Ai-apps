import { GoogleGenerativeAI } from '@google/generative-ai'
import { randomUUID } from 'crypto'
import type { BaseProvider } from './base.js'
import type { ChatCompletionRequest, ChatCompletionResponse, ModelObject } from '../schemas/openai.js'

export class GeminiProvider implements BaseProvider {
  readonly name = 'gemini'
  private client: GoogleGenerativeAI

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey)
  }

  // Convert OpenAI messages → Gemini contents + optional system instruction
  private toGemini(messages: ChatCompletionRequest['messages']) {
    let systemInstruction: string | undefined
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = (msg.content as string) ?? ''
      } else {
        contents.push({
          role:  msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: (msg.content as string) ?? '' }],
        })
      }
    }
    // Gemini requires alternating user/model turns — merge consecutive same-role messages
    const merged: typeof contents = []
    for (const c of contents) {
      const last = merged.at(-1)
      if (last && last.role === c.role) {
        last.parts.push(...c.parts)
      } else {
        merged.push({ ...c, parts: [...c.parts] })
      }
    }
    return { contents: merged, systemInstruction }
  }

  async chatComplete(req: ChatCompletionRequest, upstream: string): Promise<ChatCompletionResponse> {
    const model = this.client.getGenerativeModel({ model: upstream })
    const { contents, systemInstruction } = this.toGemini(req.messages)

    const result = await model.generateContent({
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: {
        temperature:     req.temperature,
        maxOutputTokens: req.max_tokens,
      },
    })

    const text = result.response.text()
    return {
      id:      `chatcmpl-${randomUUID()}`,
      object:  'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model:   upstream,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage:   {
        prompt_tokens:     result.response.usageMetadata?.promptTokenCount     ?? 0,
        completion_tokens: result.response.usageMetadata?.candidatesTokenCount ?? 0,
        total_tokens:      result.response.usageMetadata?.totalTokenCount      ?? 0,
      },
    }
  }

  async *chatCompleteStream(req: ChatCompletionRequest, upstream: string): AsyncGenerator<string> {
    const model = this.client.getGenerativeModel({ model: upstream })
    const { contents, systemInstruction } = this.toGemini(req.messages)

    const result = await model.generateContentStream({
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: {
        temperature:     req.temperature,
        maxOutputTokens: req.max_tokens,
      },
    })

    const id      = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)

    for await (const chunk of result.stream) {
      const text = chunk.text()
      if (!text) continue
      const data: any = {
        id, object: 'chat.completion.chunk', created, model: upstream,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      }
      yield `data: ${JSON.stringify(data)}\n\n`
    }
  }

  async listModels(): Promise<ModelObject[]> {
    const models = [
      'gemini-2.5-pro', 'gemini-2.0-flash',
      'gemini-1.5-pro', 'gemini-1.5-flash',
    ]
    return models.map(id => ({ id, object: 'model' as const, created: 0, owned_by: 'google' }))
  }

  async healthCheck(): Promise<boolean> {
    try {
      const model = this.client.getGenerativeModel({ model: 'gemini-1.5-flash' })
      await model.generateContent('ping')
      return true
    } catch {
      return false
    }
  }
}

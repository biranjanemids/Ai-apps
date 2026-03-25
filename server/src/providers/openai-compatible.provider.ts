import { OpenAIProvider } from './openai.provider.js'

/**
 * Generic OpenAI-compatible provider.
 * Works with: vLLM, LM Studio, llama.cpp server, LocalAI, Jan, Mistral local, etc.
 * Just point baseURL at the local server — no extra code needed.
 */
export class OpenAICompatibleProvider extends OpenAIProvider {
  override readonly name = 'openai-compatible'

  constructor(baseURL: string, apiKey = 'none') {
    super(apiKey, baseURL)
  }
}

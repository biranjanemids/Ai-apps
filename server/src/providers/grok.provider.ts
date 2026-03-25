import { OpenAIProvider } from './openai.provider.js'

/**
 * xAI Grok — uses the OpenAI-compatible API at api.x.ai
 * Identical streaming / tool-call logic to OpenAIProvider.
 */
export class GrokProvider extends OpenAIProvider {
  override readonly name = 'grok'

  constructor(apiKey: string) {
    super(apiKey, 'https://api.x.ai/v1')
  }
}

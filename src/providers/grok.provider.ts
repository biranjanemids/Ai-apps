/**
 * xAI Grok provider.
 * Grok exposes an OpenAI-compatible API at https://api.x.ai/v1,
 * so we simply subclass OpenAIProvider with a different base URL + key.
 */
import { OpenAIProvider } from "./openai.provider.js";
import { config } from "../config.js";

export class GrokProvider extends OpenAIProvider {
  override readonly name = "grok";

  constructor() {
    super(config.GROK_API_KEY, "https://api.x.ai/v1");
  }
}

export function makeGrokProvider(): GrokProvider {
  return new GrokProvider();
}

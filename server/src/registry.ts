import { readFileSync } from 'fs'
import { resolve } from 'path'
import yaml from 'js-yaml'
import { config } from './config.js'
import type { BaseProvider } from './providers/base.js'
import type { ModelObject } from './schemas/openai.js'
import { OpenAIProvider }           from './providers/openai.provider.js'
import { GeminiProvider }           from './providers/gemini.provider.js'
import { OllamaProvider }           from './providers/ollama.provider.js'
import { GrokProvider }             from './providers/grok.provider.js'
import { OpenAICompatibleProvider } from './providers/openai-compatible.provider.js'

interface ModelConfig {
  id:           string
  provider:     string
  upstream:     string
  base_url?:    string
  api_key?:     string
  description?: string
}

interface RegistryEntry {
  provider:     BaseProvider
  upstream:     string
  description?: string
}

export class ModelRegistry {
  private entries   = new Map<string, RegistryEntry>()
  private providers = new Map<string, BaseProvider | null>()

  load(modelsPath: string) {
    const raw  = readFileSync(resolve(modelsPath), 'utf-8')
    const data = yaml.load(raw) as { models: ModelConfig[] }

    // Instantiate shared providers once
    this.providers.set('openai', config.OPENAI_API_KEY ? new OpenAIProvider(config.OPENAI_API_KEY) : null)
    this.providers.set('gemini', config.GEMINI_API_KEY ? new GeminiProvider(config.GEMINI_API_KEY) : null)
    this.providers.set('ollama', new OllamaProvider(config.OLLAMA_BASE_URL))
    this.providers.set('grok',   config.GROK_API_KEY   ? new GrokProvider(config.GROK_API_KEY)     : null)

    for (const model of data.models) {
      let provider: BaseProvider | null = null

      if (model.provider === 'openai-compatible') {
        const cacheKey = `compat:${model.base_url}`
        if (!this.providers.has(cacheKey)) {
          this.providers.set(cacheKey, new OpenAICompatibleProvider(model.base_url!, model.api_key))
        }
        provider = this.providers.get(cacheKey) ?? null
      } else {
        provider = this.providers.get(model.provider) ?? null
      }

      if (!provider) continue   // skip models whose API key is not configured

      this.entries.set(model.id, {
        provider,
        upstream:    model.upstream,
        description: model.description,
      })
    }

    const count = this.entries.size
    console.log(`[registry] Loaded ${count} model(s) from ${modelsPath}`)
  }

  resolve(modelId: string): RegistryEntry | undefined {
    return this.entries.get(modelId)
  }

  listModels(): ModelObject[] {
    return Array.from(this.entries.entries()).map(([id, e]) => ({
      id,
      object:      'model' as const,
      created:     Math.floor(Date.now() / 1000),
      owned_by:    e.provider.name,
      description: e.description,
    }))
  }

  namedProviders(): Map<string, BaseProvider | null> {
    return this.providers
  }
}

export const registry = new ModelRegistry()

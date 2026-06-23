import { config } from './config.js'
import { modelsStore, type ModelConfig } from './models-store.js'
import type { BaseProvider } from './providers/base.js'
import type { ModelObject } from './schemas/openai.js'
import { OpenAIProvider }           from './providers/openai.provider.js'
import { GeminiProvider }           from './providers/gemini.provider.js'
import { OllamaProvider }           from './providers/ollama.provider.js'
import { GrokProvider }             from './providers/grok.provider.js'
import { OpenAICompatibleProvider } from './providers/openai-compatible.provider.js'
import { MockProvider }             from './providers/mock.provider.js'

interface RegistryEntry {
  provider:     BaseProvider
  upstream:     string
  description?: string
}

export class ModelRegistry {
  private entries   = new Map<string, RegistryEntry>()
  private providers = new Map<string, BaseProvider | null>()

  load(modelsPath: string) {
    modelsStore.load(modelsPath)

    // Instantiate shared providers once
    this.providers.set('mock',   new MockProvider())
    this.providers.set('openai', config.OPENAI_API_KEY ? new OpenAIProvider(config.OPENAI_API_KEY) : null)
    this.providers.set('gemini', config.GEMINI_API_KEY ? new GeminiProvider(config.GEMINI_API_KEY) : null)
    this.providers.set('grok',   config.GROK_API_KEY   ? new GrokProvider(config.GROK_API_KEY)     : null)
    this.providers.set('ollama', config.OLLAMA_BASE_URL ? new OllamaProvider(config.OLLAMA_BASE_URL) : null)

    for (const cfg of modelsStore.list()) {
      this._register(cfg)
    }

    console.log(`[registry] Loaded ${this.entries.size} model(s) from ${modelsPath}`)
  }

  /** Dynamically add or replace a single model entry (used by admin CRUD). */
  loadOne(cfg: ModelConfig) {
    this._register(cfg)
  }

  /** Remove a model from the live registry (does not touch models.yaml). */
  remove(id: string) {
    this.entries.delete(id)
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

  // ── Private helpers ────────────────────────────────────────────────────────

  private _register(cfg: ModelConfig) {
    const provider = this._makeProvider(cfg)
    if (!provider) return
    this.entries.set(cfg.id, {
      provider,
      upstream:    cfg.upstream,
      description: cfg.description,
    })
  }

  private _makeProvider(cfg: ModelConfig): BaseProvider | null {
    if (cfg.provider === 'openai-compatible') {
      const key = `compat:${cfg.base_url}`
      if (!this.providers.has(key)) {
        this.providers.set(key, new OpenAICompatibleProvider(cfg.base_url!, cfg.api_key))
      }
      return this.providers.get(key) ?? null
    }
    return this.providers.get(cfg.provider) ?? null
  }
}

export const registry = new ModelRegistry()

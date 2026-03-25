/**
 * Model Registry
 *
 * Loads models.yaml at startup and builds a map of:
 *   modelId  →  { provider: BaseProvider, upstream: string, meta: ModelObject }
 *
 * To add a new model: edit models.yaml — no code changes needed here.
 * To add a new provider: implement BaseProvider, register it in PROVIDER_FACTORIES below.
 */
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { BaseProvider } from "./providers/base.js";
import type { ModelObject } from "./schemas/openai.js";
import { nowSecs } from "./schemas/openai.js";
import { makeOpenAIProvider } from "./providers/openai.provider.js";
import { makeGeminiProvider } from "./providers/gemini.provider.js";
import { makeOllamaProvider } from "./providers/ollama.provider.js";
import { makeGrokProvider } from "./providers/grok.provider.js";

// ── Provider factory registry ─────────────────────────────────────────────────
// Add an entry here when you create a new provider adapter.

type ProviderFactory = () => BaseProvider;

const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  openai: makeOpenAIProvider,
  gemini: makeGeminiProvider,
  ollama: makeOllamaProvider,
  grok: makeGrokProvider,
};

// ── YAML schema ───────────────────────────────────────────────────────────────

interface ModelEntry {
  id: string;
  provider: string;
  upstream: string;
  description?: string;
}

interface ModelsYaml {
  models: ModelEntry[];
}

// ── Registry entry ────────────────────────────────────────────────────────────

export interface RegistryEntry {
  provider: BaseProvider;
  upstream: string;
  meta: ModelObject;
}

// ── Registry ──────────────────────────────────────────────────────────────────

export class ModelRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly providers = new Map<string, BaseProvider>();

  constructor(yamlPath: string) {
    const raw = fs.readFileSync(yamlPath, "utf-8");
    const doc = yaml.load(raw) as ModelsYaml;

    if (!doc?.models || !Array.isArray(doc.models)) {
      throw new Error(`models.yaml must contain a top-level "models" array`);
    }

    const created = nowSecs();

    for (const entry of doc.models) {
      const { id, provider: providerName, upstream, description } = entry;

      if (!id || !providerName || !upstream) {
        throw new Error(
          `models.yaml entry is missing required fields (id, provider, upstream): ${JSON.stringify(entry)}`
        );
      }

      const factory = PROVIDER_FACTORIES[providerName];
      if (!factory) {
        throw new Error(
          `Unknown provider "${providerName}" for model "${id}". ` +
            `Known providers: ${Object.keys(PROVIDER_FACTORIES).join(", ")}`
        );
      }

      // Reuse provider instances (one per provider type)
      if (!this.providers.has(providerName)) {
        this.providers.set(providerName, factory());
      }
      const provider = this.providers.get(providerName)!;

      this.entries.set(id, {
        provider,
        upstream,
        meta: {
          id,
          object: "model",
          created,
          owned_by: providerName,
          description,
        },
      });
    }
  }

  resolve(modelId: string): RegistryEntry {
    const entry = this.entries.get(modelId);
    if (!entry) {
      throw Object.assign(
        new Error(
          `Model "${modelId}" not found. Available: ${[...this.entries.keys()].join(", ")}`
        ),
        { status: 404, code: "model_not_found" }
      );
    }
    return entry;
  }

  listModels(): ModelObject[] {
    return [...this.entries.values()].map((e) => e.meta);
  }

  /** Returns all unique provider instances for health checks */
  getProviders(): Map<string, BaseProvider> {
    return this.providers;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _registry: ModelRegistry | null = null;

export function getRegistry(): ModelRegistry {
  if (!_registry) {
    const yamlPath = path.resolve(process.cwd(), "models.yaml");
    _registry = new ModelRegistry(yamlPath);
  }
  return _registry;
}

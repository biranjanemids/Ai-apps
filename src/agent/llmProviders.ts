import axios from 'axios';

// ── Multi-provider LLM fallback chain ────────────────────────────────────────
// All providers speak the OpenAI chat-completions format (Gemini via its
// OpenAI-compatible endpoint). On rate limits (429), server errors, or network
// failures we silently move to the next configured provider, so a Groq
// per-minute limit becomes an invisible Gemini call instead of a user-facing
// "Sorry, I ran into a problem."
//
// Providers are env-gated: only those with an API key set participate. Order
// is quality-first, with the small llama-8b as last resort.

interface ProviderDef {
  name: string;
  baseUrl: string;
  keyEnv: string;
  modelEnv: string;
  defaultModel: string;
}

const PROVIDERS: ProviderDef[] = [
  {
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    modelEnv: 'GROQ_MODEL',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  {
    name: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    defaultModel: 'gemini-2.0-flash',
  },
  {
    name: 'cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyEnv: 'CEREBRAS_API_KEY',
    modelEnv: 'CEREBRAS_MODEL',
    defaultModel: 'llama-3.3-70b',
  },
  {
    name: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    modelEnv: 'OPENROUTER_MODEL',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
  },
  // Same Groq key, smaller model — separate quota from the 70b, so it still
  // answers when everything else is exhausted.
  {
    name: 'groq-instant',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    modelEnv: 'GROQ_FALLBACK_MODEL',
    defaultModel: 'llama-3.1-8b-instant',
  },
];

export interface LlmChoice {
  finish_reason: string;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  };
}

// Groq's llama models sometimes emit malformed tool calls; Groq 400s with
// code 'tool_use_failed' and includes the intended call in failed_generation.
// Surfaced as a typed error so the caller can salvage the call.
export class ToolUseFailedError extends Error {
  constructor(public failedGeneration: string) {
    super('tool_use_failed');
  }
}

// Thrown when every configured provider failed; status reflects the most
// permissive interpretation (429 only if ALL failures were rate limits).
export class AllProvidersFailedError extends Error {
  constructor(public status: number | undefined, message: string) {
    super(message);
  }
}

function enabledProviders(): ProviderDef[] {
  return PROVIDERS.filter((p) => Boolean(process.env[p.keyEnv]));
}

export function providerSummary(): string {
  return enabledProviders()
    .map((p) => `${p.name}(${process.env[p.modelEnv] ?? p.defaultModel})`)
    .join(' → ');
}

export async function chatCompletion(
  messages: unknown[],
  tools: unknown[] | undefined,
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<LlmChoice> {
  const providers = enabledProviders();
  if (providers.length === 0) {
    throw new AllProvidersFailedError(undefined, 'No LLM provider API key configured (set GROQ_API_KEY or GEMINI_API_KEY)');
  }

  let sawNonRateLimit = false;
  let lastMessage = 'all providers failed';

  for (const provider of providers) {
    const model = process.env[provider.modelEnv] ?? provider.defaultModel;
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.6,
    };
    if (tools && tools.length > 0) {
      body['tools'] = tools;
      body['tool_choice'] = 'auto';
    }

    try {
      const { data } = await axios.post(
        `${provider.baseUrl}/chat/completions`,
        body,
        {
          headers: {
            Authorization: `Bearer ${process.env[provider.keyEnv]}`,
            'Content-Type': 'application/json',
          },
          timeout: 45_000,
        }
      );
      const choice = data?.choices?.[0];
      if (!choice?.message) throw new Error(`empty response from ${provider.name}`);
      return choice as LlmChoice;
    } catch (err) {
      // Malformed tool call (Groq-specific 400) — don't rotate providers, the
      // caller can usually salvage the intended call from failed_generation
      if (axios.isAxiosError(err)) {
        const errData = err.response?.data as
          | { error?: { code?: string; failed_generation?: string } }
          | undefined;
        if (errData?.error?.code === 'tool_use_failed') {
          throw new ToolUseFailedError(errData.error.failed_generation ?? '');
        }
      }

      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status !== undefined && status !== 429 && status < 500) sawNonRateLimit = true;
      lastMessage = err instanceof Error ? err.message : String(err);
      console.warn(
        `[LLM] ${provider.name}/${model} failed (${status ?? 'network'}) — ${
          provider === providers[providers.length - 1] ? 'no providers left' : 'trying next provider'
        }`
      );
    }
  }

  throw new AllProvidersFailedError(sawNonRateLimit ? undefined : 429, lastMessage);
}

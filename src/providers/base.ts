import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelObject,
} from "../schemas/openai.js";

/**
 * Every provider adapter must implement this interface.
 * To add a new provider:
 *   1. Create a class that implements BaseProvider in src/providers/
 *   2. Register it in src/registry.ts
 *   3. Add model entries to models.yaml
 */
export interface BaseProvider {
  /** Stable identifier used in models.yaml (e.g. "openai", "gemini") */
  readonly name: string;

  /**
   * Non-streaming completion.
   * @param req  Validated chat request (model field = upstream model name)
   * @param signal  AbortSignal for timeout / cancellation
   */
  chatComplete(
    req: ChatCompletionRequest,
    signal: AbortSignal
  ): Promise<ChatCompletionResponse>;

  /**
   * Streaming completion — yields raw SSE strings.
   * Each yielded string is a complete `data: {...}\n\n` event.
   * Caller is responsible for writing `data: [DONE]\n\n` after the generator finishes.
   */
  chatCompleteStream(
    req: ChatCompletionRequest,
    signal: AbortSignal
  ): AsyncGenerator<string, void, unknown>;

  /**
   * Returns models available from this provider.
   * Used to populate GET /v1/models.
   */
  listModels(): Promise<ModelObject[]>;

  /**
   * Lightweight connectivity check used by GET /readyz.
   * Should resolve true/false within a few seconds.
   */
  healthCheck(): Promise<boolean>;
}

// ── Shared retry helper ────────────────────────────────────────────────────────

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  { maxRetries, baseDelayMs = 500 }: RetryOptions
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const status = (err as { status?: number }).status;
      if (!status || !RETRYABLE_STATUS.has(status) || attempt === maxRetries) {
        throw err;
      }
      const delay = baseDelayMs * 2 ** attempt;
      await sleep(delay);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Shared error normaliser ────────────────────────────────────────────────────

export class ProviderError extends Error {
  constructor(
    public readonly providerName: string,
    message: string,
    public readonly status: number = 500,
    public readonly code: string = "provider_error"
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

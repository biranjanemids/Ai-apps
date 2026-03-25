import OpenAI from "openai";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelObject,
} from "../schemas/openai.js";
import { generateId, nowSecs, sseChunk } from "../schemas/openai.js";
import { BaseProvider, ProviderError, withRetry } from "./base.js";
import { config } from "../config.js";

export class OpenAIProvider implements BaseProvider {
  readonly name = "openai";
  protected readonly client: OpenAI;

  constructor(apiKey?: string, baseURL?: string) {
    this.client = new OpenAI({
      apiKey: apiKey ?? config.OPENAI_API_KEY,
      ...(baseURL ? { baseURL } : {}),
      maxRetries: 0, // we handle retries ourselves
    });
  }

  async chatComplete(
    req: ChatCompletionRequest,
    signal: AbortSignal
  ): Promise<ChatCompletionResponse> {
    return withRetry(
      async () => {
        try {
          const res = await this.client.chat.completions.create(
            {
              model: req.model,
              messages: req.messages as OpenAI.ChatCompletionMessageParam[],
              temperature: req.temperature,
              top_p: req.top_p,
              max_tokens: req.max_tokens,
              stop: req.stop as OpenAI.ChatCompletionCreateParams["stop"],
              presence_penalty: req.presence_penalty,
              frequency_penalty: req.frequency_penalty,
              user: req.user,
              stream: false,
            },
            { signal }
          );
          return res as unknown as ChatCompletionResponse;
        } catch (err: unknown) {
          throw this.normalise(err);
        }
      },
      { maxRetries: config.MAX_RETRIES }
    );
  }

  async *chatCompleteStream(
    req: ChatCompletionRequest,
    signal: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create(
        {
          model: req.model,
          messages: req.messages as OpenAI.ChatCompletionMessageParam[],
          temperature: req.temperature,
          top_p: req.top_p,
          max_tokens: req.max_tokens,
          stop: req.stop as OpenAI.ChatCompletionCreateParams["stop"],
          presence_penalty: req.presence_penalty,
          frequency_penalty: req.frequency_penalty,
          user: req.user,
          stream: true,
        },
        { signal }
      );
    } catch (err: unknown) {
      throw this.normalise(err);
    }

    for await (const chunk of stream) {
      yield sseChunk({
        id: chunk.id,
        object: "chat.completion.chunk",
        created: chunk.created,
        model: chunk.model,
        choices: chunk.choices.map((c) => ({
          index: c.index,
          delta: { role: c.delta.role, content: c.delta.content ?? undefined },
          finish_reason: c.finish_reason as "stop" | "length" | "content_filter" | null,
        })),
      });
    }
  }

  async listModels(): Promise<ModelObject[]> {
    try {
      const list = await this.client.models.list();
      return list.data.map((m) => ({
        id: m.id,
        object: "model" as const,
        created: m.created,
        owned_by: m.owned_by,
      }));
    } catch {
      return [];
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }

  protected normalise(err: unknown): ProviderError {
    if (err instanceof OpenAI.APIError) {
      return new ProviderError(
        this.name,
        err.message,
        err.status ?? 500,
        err.code ?? "api_error"
      );
    }
    return new ProviderError(this.name, String(err));
  }
}

// ── Convenience factory ───────────────────────────────────────────────────────

export function makeOpenAIProvider(): OpenAIProvider {
  return new OpenAIProvider(config.OPENAI_API_KEY);
}

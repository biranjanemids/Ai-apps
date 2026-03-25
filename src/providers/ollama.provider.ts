import { Ollama } from "ollama";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelObject,
} from "../schemas/openai.js";
import { generateId, nowSecs, sseChunk } from "../schemas/openai.js";
import { BaseProvider, ProviderError } from "./base.js";
import { config } from "../config.js";

export class OllamaProvider implements BaseProvider {
  readonly name = "ollama";
  private readonly client: Ollama;

  constructor(host?: string) {
    this.client = new Ollama({ host: host ?? config.OLLAMA_BASE_URL });
  }

  async chatComplete(
    req: ChatCompletionRequest,
    signal: AbortSignal
  ): Promise<ChatCompletionResponse> {
    try {
      const response = await this.client.chat({
        model: req.model,
        messages: req.messages.map((m) => ({
          role: m.role,
          content: m.content ?? "",
        })),
        stream: false,
        options: {
          temperature: req.temperature,
          top_p: req.top_p,
          num_predict: req.max_tokens,
          stop: Array.isArray(req.stop) ? req.stop : req.stop ? [req.stop] : undefined,
        },
      });

      const id = generateId();
      const created = nowSecs();
      return {
        id,
        object: "chat.completion",
        created,
        model: req.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: response.message.content,
            },
            finish_reason: response.done ? "stop" : null,
          },
        ],
        usage: {
          prompt_tokens: response.prompt_eval_count ?? 0,
          completion_tokens: response.eval_count ?? 0,
          total_tokens: (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0),
        },
      };
    } catch (err: unknown) {
      throw this.normalise(err);
    }
  }

  async *chatCompleteStream(
    req: ChatCompletionRequest,
    signal: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    try {
      const stream = await this.client.chat({
        model: req.model,
        messages: req.messages.map((m) => ({
          role: m.role,
          content: m.content ?? "",
        })),
        stream: true,
        options: {
          temperature: req.temperature,
          top_p: req.top_p,
          num_predict: req.max_tokens,
          stop: Array.isArray(req.stop) ? req.stop : req.stop ? [req.stop] : undefined,
        },
      });

      const id = generateId();
      const created = nowSecs();

      for await (const part of stream) {
        yield sseChunk({
          id,
          object: "chat.completion.chunk",
          created,
          model: req.model,
          choices: [
            {
              index: 0,
              delta: { content: part.message.content },
              finish_reason: part.done ? "stop" : null,
            },
          ],
        });
      }
    } catch (err: unknown) {
      throw this.normalise(err);
    }
  }

  async listModels(): Promise<ModelObject[]> {
    try {
      const list = await this.client.list();
      const created = nowSecs();
      return list.models.map((m) => ({
        id: m.name,
        object: "model" as const,
        created,
        owned_by: "ollama",
      }));
    } catch {
      return [];
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.list();
      return true;
    } catch {
      return false;
    }
  }

  private normalise(err: unknown): ProviderError {
    const msg = err instanceof Error ? err.message : String(err);
    const isConn =
      msg.includes("ECONNREFUSED") || msg.includes("fetch failed");
    return new ProviderError(
      this.name,
      isConn ? `Cannot reach Ollama at ${config.OLLAMA_BASE_URL}` : msg,
      isConn ? 503 : 500
    );
  }
}

export function makeOllamaProvider(): OllamaProvider {
  return new OllamaProvider(config.OLLAMA_BASE_URL);
}

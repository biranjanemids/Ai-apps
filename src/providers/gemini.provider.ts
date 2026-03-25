import {
  GoogleGenerativeAI,
  type Content,
  type GenerateContentStreamResult,
} from "@google/generative-ai";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelObject,
} from "../schemas/openai.js";
import { generateId, nowSecs, sseChunk } from "../schemas/openai.js";
import { BaseProvider, ProviderError, withRetry } from "./base.js";
import { config } from "../config.js";

export class GeminiProvider implements BaseProvider {
  readonly name = "gemini";
  private readonly client: GoogleGenerativeAI;

  constructor(apiKey?: string) {
    this.client = new GoogleGenerativeAI(apiKey ?? config.GEMINI_API_KEY);
  }

  async chatComplete(
    req: ChatCompletionRequest,
    signal: AbortSignal
  ): Promise<ChatCompletionResponse> {
    return withRetry(
      async () => {
        try {
          const { systemInstruction, history, lastUserMessage } =
            this.convertMessages(req.messages);

          const model = this.client.getGenerativeModel({
            model: req.model,
            ...(systemInstruction ? { systemInstruction } : {}),
            generationConfig: {
              temperature: req.temperature,
              topP: req.top_p,
              maxOutputTokens: req.max_tokens,
              stopSequences: Array.isArray(req.stop)
                ? req.stop
                : req.stop
                ? [req.stop]
                : undefined,
            },
          });

          const chat = model.startChat({ history });
          const result = await chat.sendMessage(lastUserMessage);
          const responseText = result.response.text();

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
                message: { role: "assistant", content: responseText },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: result.response.usageMetadata?.promptTokenCount ?? 0,
              completion_tokens:
                result.response.usageMetadata?.candidatesTokenCount ?? 0,
              total_tokens: result.response.usageMetadata?.totalTokenCount ?? 0,
            },
          };
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
    try {
      const { systemInstruction, history, lastUserMessage } = this.convertMessages(
        req.messages
      );

      const model = this.client.getGenerativeModel({
        model: req.model,
        ...(systemInstruction ? { systemInstruction } : {}),
        generationConfig: {
          temperature: req.temperature,
          topP: req.top_p,
          maxOutputTokens: req.max_tokens,
        },
      });

      const chat = model.startChat({ history });
      const result: GenerateContentStreamResult =
        await chat.sendMessageStream(lastUserMessage);

      const id = generateId();
      const created = nowSecs();

      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (!text) continue;

        yield sseChunk({
          id,
          object: "chat.completion.chunk",
          created,
          model: req.model,
          choices: [
            {
              index: 0,
              delta: { content: text },
              finish_reason: null,
            },
          ],
        });
      }

      // Final chunk with finish_reason
      yield sseChunk({
        id,
        object: "chat.completion.chunk",
        created,
        model: req.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
    } catch (err: unknown) {
      throw this.normalise(err);
    }
  }

  async listModels(): Promise<ModelObject[]> {
    // Gemini SDK doesn't expose a listModels method in the same way;
    // return static well-known models
    const created = nowSecs();
    return [
      { id: "gemini-1.5-pro-latest", object: "model", created, owned_by: "google" },
      { id: "gemini-1.5-flash-latest", object: "model", created, owned_by: "google" },
      { id: "gemini-2.0-flash", object: "model", created, owned_by: "google" },
    ];
  }

  async healthCheck(): Promise<boolean> {
    try {
      const model = this.client.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
      await model.generateContent("ping");
      return true;
    } catch {
      return false;
    }
  }

  // ── Message format conversion ────────────────────────────────────────────────

  private convertMessages(messages: ChatCompletionRequest["messages"]): {
    systemInstruction: string | undefined;
    history: Content[];
    lastUserMessage: string;
  } {
    let systemInstruction: string | undefined;
    const history: Content[] = [];
    let lastUserMessage = "";

    const nonSystem = messages.filter((m) => {
      if (m.role === "system") {
        systemInstruction = m.content ?? "";
        return false;
      }
      return true;
    });

    for (let i = 0; i < nonSystem.length - 1; i++) {
      const m = nonSystem[i];
      history.push({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content ?? "" }],
      });
    }

    const last = nonSystem[nonSystem.length - 1];
    if (!last) throw new ProviderError(this.name, "No user message found", 400);
    lastUserMessage = last.content ?? "";

    return { systemInstruction, history, lastUserMessage };
  }

  private normalise(err: unknown): ProviderError {
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number }).status ?? 500;
    return new ProviderError(this.name, msg, status);
  }
}

export function makeGeminiProvider(): GeminiProvider {
  return new GeminiProvider(config.GEMINI_API_KEY);
}

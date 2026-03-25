/**
 * OpenAI-compatible request / response types and JSON Schemas.
 * Used for Fastify route validation and TypeScript type safety.
 */

// ── TypeScript interfaces ─────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: "stop" | "length" | "content_filter" | null;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
}

export interface ChatCompletionChunkDelta {
  role?: string;
  content?: string;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: "stop" | "length" | "content_filter" | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
}

export interface ModelObject {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  description?: string;
}

export interface ModelList {
  object: "list";
  data: ModelObject[];
}

export interface OpenAIError {
  error: {
    message: string;
    type: string;
    code: string | null;
    param?: string | null;
  };
}

// ── Fastify JSON Schema (for request body validation) ─────────────────────────

export const chatCompletionRequestSchema = {
  type: "object",
  required: ["model", "messages"],
  properties: {
    model: { type: "string", minLength: 1 },
    messages: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["role", "content"],
        properties: {
          role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
          content: { type: ["string", "null"] },
          name: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    stream: { type: "boolean" },
    temperature: { type: "number", minimum: 0, maximum: 2 },
    top_p: { type: "number", minimum: 0, maximum: 1 },
    max_tokens: { type: "integer", minimum: 1 },
    stop: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    presence_penalty: { type: "number", minimum: -2, maximum: 2 },
    frequency_penalty: { type: "number", minimum: -2, maximum: 2 },
    user: { type: "string" },
  },
  additionalProperties: false,
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

let _counter = 0;

export function generateId(prefix = "chatcmpl"): string {
  return `${prefix}-${Date.now().toString(36)}-${(++_counter).toString(36)}`;
}

export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

export function sseChunk(chunk: ChatCompletionChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function sseDone(): string {
  return "data: [DONE]\n\n";
}

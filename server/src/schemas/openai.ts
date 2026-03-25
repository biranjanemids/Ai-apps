import { z } from 'zod'

// ── Request ──────────────────────────────────────────────────────────────────

export const MessageSchema = z.object({
  role:         z.enum(['system', 'user', 'assistant', 'tool']),
  content:      z.union([z.string(), z.null()]).optional().default(''),
  name:         z.string().optional(),
  tool_calls:   z.array(z.any()).optional(),
  tool_call_id: z.string().optional(),
})

export type Message = z.infer<typeof MessageSchema>

export const ChatCompletionRequestSchema = z.object({
  model:             z.string(),
  messages:          z.array(MessageSchema).min(1),
  temperature:       z.number().min(0).max(2).optional(),
  max_tokens:        z.number().int().positive().optional(),
  stream:            z.boolean().optional().default(false),
  stop:              z.union([z.string(), z.array(z.string())]).optional(),
  tools:             z.array(z.any()).optional(),
  tool_choice:       z.any().optional(),
  top_p:             z.number().optional(),
  presence_penalty:  z.number().optional(),
  frequency_penalty: z.number().optional(),
  user:              z.string().optional(),
})

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>

// ── Response ─────────────────────────────────────────────────────────────────

export interface ChatCompletionResponse {
  id:      string
  object:  'chat.completion'
  created: number
  model:   string
  choices: Array<{
    index:         number
    message:       { role: string; content: string | null; tool_calls?: any[] }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens:     number
    completion_tokens: number
    total_tokens:      number
  }
}

export interface ChatCompletionChunk {
  id:      string
  object:  'chat.completion.chunk'
  created: number
  model:   string
  choices: Array<{
    index:         number
    delta:         { role?: string; content?: string | null; tool_calls?: any[] }
    finish_reason: string | null
  }>
}

// ── Models ───────────────────────────────────────────────────────────────────

export interface ModelObject {
  id:          string
  object:      'model'
  created:     number
  owned_by:    string
  description?: string
}

export interface ModelList {
  object: 'list'
  data:   ModelObject[]
}

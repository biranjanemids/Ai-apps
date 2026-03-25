import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const schema = z.object({
  OPENAI_API_KEY:   z.string().default(''),
  GEMINI_API_KEY:   z.string().default(''),
  GROK_API_KEY:     z.string().default(''),
  OLLAMA_BASE_URL:  z.string().default('http://localhost:11434'),
  API_KEY:          z.string().default(''),
  PORT:             z.coerce.number().default(3000),
  HOST:             z.string().default('0.0.0.0'),
  LOG_LEVEL:        z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  REQUEST_TIMEOUT:  z.coerce.number().default(120000),
  MAX_RETRIES:      z.coerce.number().default(2),
  CORS_ORIGIN:      z.string().default('*'),
})

export const config = schema.parse(process.env)
export type Config = typeof config

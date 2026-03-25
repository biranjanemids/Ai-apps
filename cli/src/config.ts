import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const schema = z.object({
  AI_SERVER_URL: z.string().url().default('http://localhost:3000'),
  AI_API_KEY:    z.string().default(''),
  AI_MODEL:      z.string().default('gpt-4o'),
})

export const env = schema.parse(process.env)

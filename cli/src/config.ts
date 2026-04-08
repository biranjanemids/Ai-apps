import { z }               from 'zod'
import dotenv              from 'dotenv'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { join }            from 'path'
import { homedir }         from 'os'

dotenv.config()

const CONFIG_PATH = join(homedir(), '.ai-code', 'config.json')
const CONFIG_DIR  = join(homedir(), '.ai-code')

// Load config file (lowest priority — overridden by env vars and CLI flags)
function loadFileConfig(): Record<string, string> {
  if (!existsSync(CONFIG_PATH)) {
    // Create default config file on first run
    try {
      mkdirSync(CONFIG_DIR, { recursive: true })
      writeFileSync(CONFIG_PATH, JSON.stringify({
        AI_SERVER_URL: 'http://localhost:3000',
        AI_API_KEY:    '',
        AI_MODEL:      'gpt-4o',
      }, null, 2), 'utf-8')
    } catch {}
    return {}
  }
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

const fileConfig = loadFileConfig()

// Merge: env vars override file config
const merged = { ...fileConfig, ...process.env }

const schema = z.object({
  AI_SERVER_URL: z.string().url().default('http://localhost:3000'),
  AI_API_KEY:    z.string().default(''),
  AI_MODEL:      z.string().default('gpt-4o'),
})

export const env = schema.parse(merged)
export { CONFIG_PATH }

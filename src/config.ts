import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
    .default("info"),

  // Auth — leave empty to disable
  API_KEY: z.string().default(""),

  // CORS
  CORS_ORIGIN: z.string().default("*"),

  // Upstream request settings
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  // Provider credentials
  OPENAI_API_KEY: z.string().default(""),
  GEMINI_API_KEY: z.string().default(""),
  GROK_API_KEY: z.string().default(""),
  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌  Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`    ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

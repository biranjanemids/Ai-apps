# Multi-Model API

An OpenAI-compatible HTTP API gateway that routes requests to multiple AI providers through a single interface. Adding new models requires only a one-line entry in `models.yaml` — no code changes.

## Providers supported

| Provider | Models |
|---|---|
| **OpenAI** | GPT-4o, GPT-4o Mini, GPT-4 Turbo |
| **Google Gemini** | Gemini 1.5 Pro/Flash, Gemini 2.0 Flash |
| **Ollama** (local) | Llama 3, Mistral, CodeLlama, any pulled model |
| **xAI Grok** | Grok Beta, Grok 2 |

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your API keys

# 3. Run (dev mode with hot reload)
npm run dev

# 4. Verify
curl http://localhost:3000/health
curl http://localhost:3000/v1/models
```

## API

All endpoints are OpenAI-compatible — any OpenAI SDK can point to this server by changing `baseURL`.

### `POST /v1/chat/completions`

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

#### Streaming

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "gemini-1.5-pro",
    "messages": [{"role": "user", "content": "Tell me a joke"}],
    "stream": true
  }'
```

### `GET /v1/models`

Returns all models registered in `models.yaml`.

### `GET /health`

Liveness probe — always fast, no upstream calls.

### `GET /readyz`

Readiness probe — tests connectivity to each configured provider.

## Using with OpenAI SDK

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "your-api-key",  // matches API_KEY in .env
});

const response = await client.chat.completions.create({
  model: "gpt-4o",        // or "gemini-1.5-pro", "llama3", "grok-beta"
  messages: [{ role: "user", content: "Hello!" }],
});
```

## Adding a new model

Edit `models.yaml`:

```yaml
- id: my-new-model
  provider: openai
  upstream: gpt-4o-2024-11-20
  description: "My custom model alias"
```

Restart the server — no code changes needed.

## Adding a new provider

1. Create `src/providers/myprovider.provider.ts` implementing `BaseProvider`
2. Register a factory in `src/registry.ts` → `PROVIDER_FACTORIES`
3. Add `MYPROVIDER_API_KEY` to `src/config.ts` and `.env.example`
4. Add model entries to `models.yaml`

## Docker

```bash
docker compose up -d

# Pull a local model into Ollama
docker exec ollama ollama pull llama3
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `API_KEY` | *(empty)* | Bearer token for auth. Leave empty to disable. |
| `LOG_LEVEL` | `info` | `trace`/`debug`/`info`/`warn`/`error` |
| `REQUEST_TIMEOUT_MS` | `120000` | Upstream timeout (ms) |
| `MAX_RETRIES` | `2` | Retries on 429/503 upstream errors |
| `CORS_ORIGIN` | `*` | Comma-separated allowed origins |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `GEMINI_API_KEY` | — | Google Gemini API key |
| `GROK_API_KEY` | — | xAI Grok API key |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |

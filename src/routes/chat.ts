import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ChatCompletionRequest } from "../schemas/openai.js";
import { chatCompletionRequestSchema, sseDone } from "../schemas/openai.js";
import { getRegistry } from "../registry.js";
import { ProviderError } from "../providers/base.js";
import { config } from "../config.js";

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: ChatCompletionRequest }>(
    "/v1/chat/completions",
    {
      schema: {
        tags: ["Chat"],
        body: chatCompletionRequestSchema,
      },
    },
    async (req: FastifyRequest<{ Body: ChatCompletionRequest }>, reply: FastifyReply) => {
      const body = req.body;
      const requestId = (req.headers["x-request-id"] as string) ?? req.id;

      // Resolve model → provider + upstream model name
      let entry;
      try {
        entry = getRegistry().resolve(body.model);
      } catch (err: unknown) {
        return sendError(reply, err, 404);
      }

      // Build the request with the upstream model name
      const upstreamReq: ChatCompletionRequest = { ...body, model: entry.upstream };

      // Timeout via AbortSignal
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), config.REQUEST_TIMEOUT_MS);

      req.log.info(
        { requestId, model: body.model, upstream: entry.upstream, stream: body.stream },
        "chat.completions request"
      );

      try {
        if (body.stream) {
          return await handleStream(reply, entry.provider, upstreamReq, ac.signal, body.model, requestId);
        } else {
          return await handleComplete(reply, entry.provider, upstreamReq, ac.signal, body.model, req);
        }
      } catch (err: unknown) {
        return sendError(reply, err);
      } finally {
        clearTimeout(timer);
      }
    }
  );
}

// ── Non-streaming ─────────────────────────────────────────────────────────────

async function handleComplete(
  reply: FastifyReply,
  provider: import("../providers/base.js").BaseProvider,
  req: ChatCompletionRequest,
  signal: AbortSignal,
  publicModelId: string,
  fastifyReq: FastifyRequest
): Promise<void> {
  const response = await provider.chatComplete(req, signal);
  // Rewrite model field to the public-facing model ID
  response.model = publicModelId;
  fastifyReq.log.info(
    { model: publicModelId, usage: response.usage },
    "chat.completions response"
  );
  reply.send(response);
}

// ── Streaming ─────────────────────────────────────────────────────────────────

async function handleStream(
  reply: FastifyReply,
  provider: import("../providers/base.js").BaseProvider,
  req: ChatCompletionRequest,
  signal: AbortSignal,
  publicModelId: string,
  requestId: string
): Promise<void> {
  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
  reply.raw.setHeader("X-Request-Id", requestId);
  reply.raw.flushHeaders();

  try {
    // Rewrite model in chunks to the public-facing ID via a transform in the generator
    for await (const chunk of provider.chatCompleteStream(req, signal)) {
      // Inject the public model ID into the SSE chunk JSON
      const sse = rewriteModelInChunk(chunk, publicModelId);
      reply.raw.write(sse);
    }
    reply.raw.write(sseDone());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Streaming error";
    reply.raw.write(`data: ${JSON.stringify({ error: { message: msg, type: "stream_error" } })}\n\n`);
    reply.raw.write(sseDone());
  } finally {
    reply.raw.end();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rewriteModelInChunk(sseChunkStr: string, modelId: string): string {
  try {
    if (!sseChunkStr.startsWith("data: ")) return sseChunkStr;
    const json = JSON.parse(sseChunkStr.slice(6).trim());
    json.model = modelId;
    return `data: ${JSON.stringify(json)}\n\n`;
  } catch {
    return sseChunkStr;
  }
}

function sendError(reply: FastifyReply, err: unknown, defaultStatus = 500): void {
  if (err instanceof ProviderError) {
    reply.status(err.status).send({
      error: {
        message: err.message,
        type: "provider_error",
        code: err.code,
        param: null,
      },
    });
    return;
  }

  const status = (err as { status?: number }).status ?? defaultStatus;
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string }).code ?? null;

  reply.status(status).send({
    error: { message, type: "invalid_request_error", code, param: null },
  });
}

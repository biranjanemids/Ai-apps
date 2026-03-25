import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { requestContext } from "@fastify/request-context";
import { config } from "./config.js";
import { chatRoutes } from "./routes/chat.js";
import { modelRoutes } from "./routes/models.js";
import { healthRoutes } from "./routes/health.js";
import { getRegistry } from "./registry.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport:
        process.env.NODE_ENV !== "production"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
    genReqId: () =>
      `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    trustProxy: true,
  });

  // ── Request context (request-id propagation) ─────────────────────────────────
  await app.register(requestContext, {
    defaultStoreValues: { requestId: "" },
  });

  app.addHook("onRequest", async (req) => {
    requestContext.set("requestId", req.id);
  });

  // ── CORS ─────────────────────────────────────────────────────────────────────
  await app.register(cors, {
    origin: config.CORS_ORIGIN === "*" ? true : config.CORS_ORIGIN.split(","),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id"],
  });

  // ── Rate limiting ─────────────────────────────────────────────────────────────
  await app.register(rateLimit, {
    max: 120,         // requests per window per IP
    timeWindow: "1 minute",
    errorResponseBuilder: (_req, context) => ({
      error: {
        message: `Rate limit exceeded. Retry after ${context.after}.`,
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
        param: null,
      },
    }),
  });

  // ── Auth hook (Bearer token on /v1/* routes) ──────────────────────────────────
  app.addHook("onRequest", async (req, reply) => {
    if (!config.API_KEY) return; // auth disabled
    if (!req.url.startsWith("/v1/")) return; // only protect /v1/

    const auth = req.headers["authorization"];
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;

    if (!token || token !== config.API_KEY) {
      reply.status(401).send({
        error: {
          message: "Invalid or missing API key. Provide it as: Authorization: Bearer <key>",
          type: "authentication_error",
          code: "invalid_api_key",
          param: null,
        },
      });
    }
  });

  // ── Propagate request ID in response headers ──────────────────────────────────
  app.addHook("onSend", async (req, reply) => {
    reply.header("X-Request-Id", req.id);
  });

  // ── Routes ────────────────────────────────────────────────────────────────────
  await app.register(healthRoutes);
  await app.register(modelRoutes);
  await app.register(chatRoutes);

  // ── Global error handler — normalise all errors to OpenAI format ──────────────
  app.setErrorHandler((error, req, reply) => {
    req.log.error({ err: error, requestId: req.id }, "Unhandled error");

    const status = error.statusCode ?? 500;
    const isValidation = error.validation != null;

    reply.status(status).send({
      error: {
        message: isValidation
          ? `Invalid request: ${error.message}`
          : (error.message || "Internal server error"),
        type: isValidation ? "invalid_request_error" : "server_error",
        code: isValidation ? "invalid_parameters" : null,
        param: null,
      },
    });
  });

  // ── 404 handler ───────────────────────────────────────────────────────────────
  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      error: {
        message: `Route ${req.method} ${req.url} not found`,
        type: "invalid_request_error",
        code: "route_not_found",
        param: null,
      },
    });
  });

  // Eagerly load the registry so startup errors are surfaced immediately
  getRegistry();

  return app;
}

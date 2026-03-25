import type { FastifyInstance } from "fastify";
import { getRegistry } from "../registry.js";

export async function modelRoutes(app: FastifyInstance): Promise<void> {
  /** GET /v1/models — list all models registered in models.yaml */
  app.get(
    "/v1/models",
    { schema: { tags: ["Models"] } },
    async (_req, reply) => {
      const models = getRegistry().listModels();
      reply.send({ object: "list", data: models });
    }
  );

  /** GET /v1/models/:model — retrieve a single model */
  app.get<{ Params: { model: string } }>(
    "/v1/models/:model",
    { schema: { tags: ["Models"] } },
    async (req, reply) => {
      try {
        const entry = getRegistry().resolve(req.params.model);
        reply.send(entry.meta);
      } catch (err: unknown) {
        const status = (err as { status?: number }).status ?? 404;
        const message = err instanceof Error ? err.message : String(err);
        reply.status(status).send({
          error: { message, type: "invalid_request_error", code: "model_not_found", param: "model" },
        });
      }
    }
  );
}

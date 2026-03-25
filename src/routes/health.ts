import type { FastifyInstance } from "fastify";
import { getRegistry } from "../registry.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /** GET /health — liveness probe (always fast, no upstream calls) */
  app.get(
    "/health",
    { schema: { tags: ["Observability"] } },
    async (_req, reply) => {
      reply.send({ status: "ok", timestamp: new Date().toISOString() });
    }
  );

  /**
   * GET /readyz — readiness probe.
   * Checks each registered provider's connectivity.
   * Returns 200 if all checks pass, 503 if any fail.
   */
  app.get(
    "/readyz",
    { schema: { tags: ["Observability"] } },
    async (_req, reply) => {
      const registry = getRegistry();
      const providers = registry.getProviders();

      const checks = await Promise.allSettled(
        [...providers.entries()].map(async ([name, provider]) => {
          const healthy = await Promise.race([
            provider.healthCheck(),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
          ]);
          return { name, healthy };
        })
      );

      const results: Record<string, "ok" | "error"> = {};
      let allOk = true;

      for (const check of checks) {
        if (check.status === "fulfilled") {
          results[check.value.name] = check.value.healthy ? "ok" : "error";
          if (!check.value.healthy) allOk = false;
        } else {
          const match = String(check.reason).match(/provider[: ]+(\w+)/i);
          const name = match?.[1] ?? "unknown";
          results[name] = "error";
          allOk = false;
        }
      }

      reply.status(allOk ? 200 : 503).send({
        status: allOk ? "ok" : "degraded",
        providers: results,
        timestamp: new Date().toISOString(),
      });
    }
  );
}

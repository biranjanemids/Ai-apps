import { buildApp } from "./app.js";
import { config } from "./config.js";

async function start(): Promise<void> {
  const app = await buildApp();

  // ── Graceful shutdown ─────────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "Shutdown signal received — draining connections…");
    try {
      await app.close();
      app.log.info("Server closed gracefully");
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "Error during graceful shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    app.log.fatal({ err }, "Uncaught exception");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    app.log.fatal({ reason }, "Unhandled promise rejection");
    process.exit(1);
  });

  // ── Start ─────────────────────────────────────────────────────────────────────
  try {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
    app.log.info(
      {
        port: config.PORT,
        auth: config.API_KEY ? "enabled" : "disabled",
        logLevel: config.LOG_LEVEL,
      },
      "🚀  Multi-model API server started"
    );
  } catch (err) {
    app.log.fatal({ err }, "Failed to start server");
    process.exit(1);
  }
}

void start();

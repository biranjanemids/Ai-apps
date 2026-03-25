import type { FastifyPluginAsync } from 'fastify'
import { registry } from '../registry.js'

export const healthRoutes: FastifyPluginAsync = async (app) => {
  // Liveness — always returns 200 if the process is up
  app.get('/health', async () => ({
    status:    'ok',
    timestamp: new Date().toISOString(),
  }))

  // Readiness — checks each configured provider
  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, boolean | string> = {}

    for (const [name, provider] of registry.namedProviders()) {
      if (!provider) {
        checks[name] = 'not configured'
        continue
      }
      try {
        checks[name] = await Promise.race<boolean>([
          provider.healthCheck(),
          new Promise<boolean>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5_000)),
        ])
      } catch (err: any) {
        checks[name] = err?.message ?? 'error'
      }
    }

    const anyOk = Object.values(checks).some(v => v === true)
    reply.status(anyOk ? 200 : 503)
    return { status: anyOk ? 'ok' : 'degraded', providers: checks }
  })
}

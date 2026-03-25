import Fastify from 'fastify'
import cors      from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { config }       from './config.js'
import { chatRoutes }   from './routes/chat.js'
import { modelRoutes }  from './routes/models.js'
import { healthRoutes } from './routes/health.js'

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      ...(process.env.NODE_ENV !== 'production'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    },
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: 'x-request-id',
  })

  // ── Plugins ────────────────────────────────────────────────────────────────
  await app.register(cors, { origin: config.CORS_ORIGIN })
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' })

  // ── Auth middleware ────────────────────────────────────────────────────────
  if (config.API_KEY) {
    app.addHook('onRequest', async (req, reply) => {
      // Skip auth for health probes
      if (req.url === '/health' || req.url === '/readyz') return

      const auth = req.headers['authorization']
      if (!auth || auth !== `Bearer ${config.API_KEY}`) {
        return reply.status(401).send({
          error: { message: 'Unauthorized', type: 'auth_error', code: 'unauthorized' },
        })
      }
    })
  }

  // ── Request ID propagation ─────────────────────────────────────────────────
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id)
  })

  // ── Normalize all errors to OpenAI format ─────────────────────────────────
  app.setErrorHandler((error, _req, reply) => {
    const status = error.statusCode ?? 500
    app.log.error({ err: error }, 'Request error')
    reply.status(status).send({
      error: { message: error.message, type: 'api_error', code: status },
    })
  })

  // ── Routes ─────────────────────────────────────────────────────────────────
  await app.register(healthRoutes)
  await app.register(chatRoutes)
  await app.register(modelRoutes)

  return app
}

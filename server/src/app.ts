import { readFileSync }  from 'fs'
import { join }          from 'path'
import Fastify    from 'fastify'
import cors       from '@fastify/cors'
import rateLimit  from '@fastify/rate-limit'
import { config }        from './config.js'
import { chatRoutes }    from './routes/chat.js'
import { modelRoutes }   from './routes/models.js'
import { healthRoutes }  from './routes/health.js'
import { adminRoutes }   from './routes/admin.js'
import { ollamaRoutes }  from './routes/ollama-mgmt.js'

// Resolve from CWD — server must be started from the server/ directory
const UI_HTML = join(process.cwd(), 'public', 'index.html')

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
    const OPEN_PATHS = new Set(['/health', '/readyz', '/', '/ui'])
    app.addHook('onRequest', async (req, reply) => {
      if (OPEN_PATHS.has(req.url.split('?')[0])) return
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
    const status = (error as any).statusCode ?? 500
    app.log.error({ err: error }, 'Request error')
    reply.status(status).send({
      error: { message: error.message, type: 'api_error', code: status },
    })
  })

  // ── Web dashboard UI ───────────────────────────────────────────────────────
  app.get('/', async (_req, reply) => {
    try {
      const html = readFileSync(UI_HTML, 'utf-8')
      return reply.type('text/html; charset=utf-8').send(html)
    } catch {
      return reply.type('text/html').send('<h1>UI not found — run from server/ directory</h1>')
    }
  })

  app.get('/ui', async (_req, reply) => {
    return reply.redirect('/')
  })

  // ── API routes ─────────────────────────────────────────────────────────────
  await app.register(healthRoutes)
  await app.register(chatRoutes)
  await app.register(modelRoutes)
  await app.register(adminRoutes)
  await app.register(ollamaRoutes)

  return app
}

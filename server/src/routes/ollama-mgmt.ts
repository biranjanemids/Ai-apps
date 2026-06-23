import type { FastifyInstance } from 'fastify'
import { Ollama }      from 'ollama'
import { config }      from '../config.js'
import { modelsStore } from '../models-store.js'
import { registry }    from '../registry.js'

function client() {
  return new Ollama({ host: config.OLLAMA_BASE_URL || 'http://localhost:11434' })
}

export async function ollamaRoutes(app: FastifyInstance) {
  // ── List installed local models ────────────────────────────────────────────
  app.get('/admin/ollama/models', async (_req, reply) => {
    try {
      const { models } = await client().list()
      return reply.send({ models })
    } catch (e: any) {
      return reply.status(503).send({
        error: { message: 'Ollama not reachable', detail: e.message },
      })
    }
  })

  // ── Running model processes ────────────────────────────────────────────────
  app.get('/admin/ollama/ps', async (_req, reply) => {
    try {
      const result = await (client() as any).ps()
      return reply.send(result)
    } catch (e: any) {
      return reply.status(503).send({
        error: { message: 'Ollama not reachable', detail: e.message },
      })
    }
  })

  // ── Pull model with SSE progress ───────────────────────────────────────────
  app.post('/admin/ollama/pull', async (req, reply) => {
    const { name, register } = req.body as { name?: string; register?: boolean }
    if (!name) {
      return reply.status(400).send({ error: { message: '"name" is required' } })
    }

    reply.raw.writeHead(200, {
      'Content-Type':    'text/event-stream',
      'Cache-Control':   'no-cache',
      'Connection':      'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const send = (data: object) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)

    try {
      const stream = await client().pull({ model: name, stream: true })
      for await (const progress of stream) {
        send({
          status:    progress.status,
          total:     (progress as any).total     ?? null,
          completed: (progress as any).completed ?? null,
          digest:    (progress as any).digest    ?? null,
        })
      }

      if (register) {
        const id = `ollama/${name.replace(/:/g, '-')}`
        if (!modelsStore.get(id)) {
          const cfg = {
            id,
            provider:    'ollama' as const,
            upstream:    name,
            description: `Ollama — ${name}`,
          }
          modelsStore.add(cfg)
          registry.loadOne(cfg)
        }
      }

      send({ status: 'success', model: name })
    } catch (e: any) {
      send({ status: 'error', error: e.message })
    } finally {
      reply.raw.end()
    }
  })

  // ── Delete Ollama model ────────────────────────────────────────────────────
  app.delete('/admin/ollama/models/:name', async (req, reply) => {
    const name = decodeURIComponent((req.params as any).name)
    try {
      await client().delete({ model: name })
      return reply.status(204).send()
    } catch (e: any) {
      return reply.status(503).send({ error: { message: e.message } })
    }
  })

  // ── Register an installed Ollama model in the gateway ─────────────────────
  app.post('/admin/ollama/register', async (req, reply) => {
    const { name } = req.body as { name?: string }
    if (!name) return reply.status(400).send({ error: { message: '"name" is required' } })

    const id = `ollama/${name.replace(/:/g, '-')}`
    if (modelsStore.get(id)) {
      return reply.status(409).send({ error: { message: `Model '${id}' already registered` } })
    }
    const cfg = { id, provider: 'ollama' as const, upstream: name, description: `Ollama — ${name}` }
    modelsStore.add(cfg)
    registry.loadOne(cfg)
    return reply.status(201).send({ model: { ...cfg, status: registry.resolve(id) ? 'available' : 'unavailable' } })
  })
}

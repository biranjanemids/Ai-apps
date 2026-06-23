import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { modelsStore } from '../models-store.js'
import { registry }    from '../registry.js'

const PROVIDERS = ['mock', 'openai', 'gemini', 'grok', 'ollama', 'openai-compatible'] as const

const ModelBody = z.object({
  id:          z.string().min(1),
  provider:    z.enum(PROVIDERS),
  upstream:    z.string().min(1),
  base_url:    z.string().url().optional(),
  api_key:     z.string().optional(),
  description: z.string().optional(),
})

const ModelPatch = ModelBody.partial().omit({ id: true })

export async function adminRoutes(app: FastifyInstance) {
  // ── List all configured models (with live status) ─────────────────────────
  app.get('/admin/models', async (_req, reply) => {
    const configs = modelsStore.list()
    const models = configs.map(cfg => ({
      ...cfg,
      status: registry.resolve(cfg.id) ? 'available' : 'unavailable',
    }))
    return reply.send({ models, total: models.length })
  })

  // ── Create model ───────────────────────────────────────────────────────────
  app.post('/admin/models', async (req, reply) => {
    const body = ModelBody.parse(req.body)
    modelsStore.add(body)
    registry.loadOne(body)
    const status = registry.resolve(body.id) ? 'available' : 'unavailable'
    return reply.status(201).send({ model: { ...body, status } })
  })

  // ── Update model ───────────────────────────────────────────────────────────
  app.put('/admin/models/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const patch   = ModelPatch.parse(req.body)
    const updated = modelsStore.update(id, patch)
    registry.loadOne(updated)
    const status = registry.resolve(id) ? 'available' : 'unavailable'
    return reply.send({ model: { ...updated, status } })
  })

  // ── Delete model ───────────────────────────────────────────────────────────
  app.delete('/admin/models/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    modelsStore.remove(id)
    registry.remove(id)
    return reply.status(204).send()
  })

  // ── Test model (quick liveness check) ─────────────────────────────────────
  app.post('/admin/models/:id/test', async (req, reply) => {
    const { id }  = req.params as { id: string }
    const entry   = registry.resolve(id)
    if (!entry) {
      return reply.status(404).send({
        error: { message: `Model '${id}' is not available` },
      })
    }
    try {
      const result = await entry.provider.chatComplete(
        {
          model:      id,
          messages:   [{ role: 'user', content: 'Reply with just "OK".' }],
          max_tokens: 20,
          stream:     false,
        },
        entry.upstream,
      )
      return reply.send({
        success:  true,
        response: result.choices[0]?.message?.content ?? '',
        usage:    result.usage,
      })
    } catch (e: any) {
      return reply.send({ success: false, error: e.message })
    }
  })
}

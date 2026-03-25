import type { FastifyPluginAsync } from 'fastify'
import { registry } from '../registry.js'

export const modelRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/models', async () => ({
    object: 'list',
    data:   registry.listModels(),
  }))
}

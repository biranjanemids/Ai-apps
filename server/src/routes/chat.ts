import type { FastifyPluginAsync } from 'fastify'
import { ZodError } from 'zod'
import { ChatCompletionRequestSchema } from '../schemas/openai.js'
import { registry } from '../registry.js'
import { config } from '../config.js'

export const chatRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/chat/completions', async (request, reply) => {
    // Validate request body
    let body
    try {
      body = ChatCompletionRequestSchema.parse(request.body)
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({
          error: {
            message: err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
            type:    'invalid_request_error',
            code:    'validation_error',
          },
        })
      }
      throw err
    }

    // Resolve model → provider
    const entry = registry.resolve(body.model)
    if (!entry) {
      return reply.status(404).send({
        error: {
          message: `Model '${body.model}' not found. Use GET /v1/models to list available models.`,
          type:    'invalid_request_error',
          code:    'model_not_found',
        },
      })
    }

    const timeout = config.REQUEST_TIMEOUT
    const ac      = new AbortController()
    const timer   = setTimeout(() => ac.abort(), timeout)

    try {
      if (body.stream) {
        // Streaming — write SSE directly to raw response
        reply.raw.setHeader('Content-Type',  'text/event-stream')
        reply.raw.setHeader('Cache-Control', 'no-cache')
        reply.raw.setHeader('Connection',    'keep-alive')
        reply.raw.setHeader('X-Accel-Buffering', 'no')

        for await (const chunk of entry.provider.chatCompleteStream(body, entry.upstream)) {
          if (ac.signal.aborted) break
          reply.raw.write(chunk)
        }
        reply.raw.write('data: [DONE]\n\n')
        reply.raw.end()
        return reply
      }

      // Non-streaming
      const response = await entry.provider.chatComplete(body, entry.upstream)
      return response

    } finally {
      clearTimeout(timer)
    }
  })
}

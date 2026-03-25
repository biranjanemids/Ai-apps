import { resolve } from 'path'
import { buildApp } from './app.js'
import { registry } from './registry.js'
import { config }   from './config.js'

const app = await buildApp()

// Load model registry
registry.load(resolve(process.cwd(), 'models.yaml'))

// Graceful shutdown
const shutdown = async (signal: string) => {
  app.log.info(`Received ${signal} — shutting down`)
  await app.close()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

// Start
await app.listen({ port: config.PORT, host: config.HOST })
app.log.info(`Multi-model API ready → http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}`)

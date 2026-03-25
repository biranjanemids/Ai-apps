#!/usr/bin/env node
import React from 'react'
import { render } from 'ink'
import { Command } from 'commander'
import { resolve } from 'path'
import { env } from './config.js'
import { Agent } from './agent.js'
import { ApiClient } from './client.js'
import { App } from './app.js'

const program = new Command()

program
  .name('ai-code')
  .description('AI coding assistant — Windsurf/Cursor-style CLI powered by your multi-model server')
  .version('1.0.0')
  .argument('[project-dir]', 'Project directory to work in', '.')
  .option('-m, --model <id>',   'Model to use',             env.AI_MODEL)
  .option('-s, --server <url>', 'API server URL',           env.AI_SERVER_URL)
  .option('-k, --api-key <key>','API key for the server',   env.AI_API_KEY)
  .action(async (projectDir: string, opts) => {
    const cwd       = resolve(process.cwd(), projectDir)
    const serverUrl = opts.server  as string
    const apiKey    = opts.apiKey  as string
    const model     = opts.model   as string

    // Check server connectivity
    const client = new ApiClient(serverUrl, apiKey)
    const alive  = await client.healthCheck()
    if (!alive) {
      console.error(`✖  Cannot reach API server at ${serverUrl}`)
      console.error(`   Start the server first: cd server && npm run dev`)
      process.exit(1)
    }

    // Fetch available models
    const models = await client.listModels()

    // Build agent
    const agent = new Agent(cwd, model, serverUrl, apiKey)

    // Launch TUI
    const { waitUntilExit } = render(
      React.createElement(App, { agent, initialModel: model, cwd, models }),
      { fullscreen: true, exitOnCtrlC: true },
    )

    await waitUntilExit()
    process.exit(0)
  })

program.parse()

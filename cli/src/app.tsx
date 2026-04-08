import React, { useState, useCallback } from 'react'
import { Box, useApp } from 'ink'
import { ChatPanel, type ChatMessage } from './components/ChatPanel.js'
import { FileTree }  from './components/FileTree.js'
import { StatusBar } from './components/StatusBar.js'
import { Agent, type AgentEvent } from './agent.js'

interface Props {
  agent:        Agent
  initialModel: string
  cwd:          string
  models:       string[]
}

export function App({ agent, initialModel, cwd, models }: Props) {
  const { exit } = useApp()

  const [messages,     setMessages]     = useState<ChatMessage[]>([])
  const [input,        setInput]        = useState('')
  const [model,        setModel]        = useState(initialModel)
  const [status,       setStatus]       = useState<'idle' | 'thinking' | 'streaming' | 'error'>('idle')
  const [changedFiles, setChangedFiles] = useState<Set<string>>(new Set())
  const [tree,         setTree]         = useState(agent.getContext().tree)
  const [tokens,       setTokens]       = useState(0)

  const addSystemMsg = (content: string) =>
    setMessages(prev => [...prev, { role: 'system' as const, content }])

  const handleSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return
    setInput('')

    // ── Slash commands ──────────────────────────────────────────────────────
    if (trimmed === '/exit' || trimmed === '/quit') { exit(); return }

    if (trimmed === '/clear') {
      agent.clearHistory()
      setMessages([])
      setChangedFiles(new Set())
      setTokens(0)
      return
    }

    if (trimmed === '/context') {
      const ctx = agent.getContext()
      addSystemMsg(`Context: ${ctx.files.size} files indexed\n${ctx.tree.slice(0, 600)}`)
      return
    }

    if (trimmed === '/models') {
      addSystemMsg(models.length
        ? `Available models:\n${models.map(m => `  • ${m}`).join('\n')}`
        : 'No models found — is the server running?')
      return
    }

    if (trimmed.startsWith('/model ')) {
      const newModel = trimmed.slice(7).trim()
      agent.setModel(newModel)
      setModel(newModel)
      addSystemMsg(`Switched to model: ${newModel}`)
      return
    }

    if (trimmed === '/save') {
      const path = agent.saveSession()
      addSystemMsg(`Session saved to: ${path}`)
      return
    }

    if (trimmed === '/load') {
      const ok = agent.loadSession()
      if (ok) {
        addSystemMsg('Session loaded. History restored.')
      } else {
        addSystemMsg('No saved session found for this project.')
      }
      return
    }

    if (trimmed === '/history') {
      const sessions = agent.listSessions()
      addSystemMsg(sessions.length
        ? `Saved sessions:\n${sessions.map(s => `  ${s}`).join('\n')}`
        : 'No saved sessions found.')
      return
    }

    if (trimmed === '/help') {
      addSystemMsg([
        'Slash commands:',
        '  /model <id>   — switch model',
        '  /models       — list available models',
        '  /clear        — clear conversation',
        '  /save         — save session to disk',
        '  /load         — restore last session',
        '  /history      — list saved sessions',
        '  /context      — show indexed files',
        '  /exit         — quit',
      ].join('\n'))
      return
    }

    // ── Regular message → agentic loop ─────────────────────────────────────
    setMessages(prev => [...prev, { role: 'user', content: trimmed }])
    setStatus('thinking')

    const assistantIdx = messages.length + 1
    setMessages(prev => [...prev, {
      role:        'assistant',
      content:     '',
      toolCalls:   [],
      diffs:       [],
      isStreaming: true,
    }])

    const newChanged = new Set(changedFiles)

    try {
      for await (const event of agent.run(trimmed)) {
        handleEvent(event, assistantIdx, newChanged)
      }
    } catch (err: any) {
      setMessages(prev => {
        const u = [...prev]
        if (u[assistantIdx]) u[assistantIdx] = { ...u[assistantIdx], content: `Error: ${err.message}`, isStreaming: false }
        return u
      })
      setStatus('error')
      return
    }

    setChangedFiles(newChanged)
    setTree(agent.getContext().tree)
    setStatus('idle')
  }, [input, messages, changedFiles, model, models, agent, exit])

  function handleEvent(event: AgentEvent, msgIdx: number, newChanged: Set<string>) {
    switch (event.type) {
      case 'token':
        setStatus('streaming')
        setMessages(prev => {
          const u = [...prev]
          if (u[msgIdx]) u[msgIdx] = { ...u[msgIdx], content: (u[msgIdx].content ?? '') + event.content }
          return u
        })
        break

      case 'tool_start':
        setMessages(prev => {
          const u = [...prev]
          if (u[msgIdx]) {
            const toolCalls = [...(u[msgIdx].toolCalls ?? []), { name: event.name, args: event.args, done: false }]
            u[msgIdx] = { ...u[msgIdx], toolCalls }
          }
          return u
        })
        break

      case 'tool_end': {
        if (event.result.changedFile) newChanged.add(event.result.changedFile)
        setMessages(prev => {
          const u = [...prev]
          if (u[msgIdx]) {
            const toolCalls = (u[msgIdx].toolCalls ?? []).map(tc =>
              tc.name === event.name && !tc.done
                ? { ...tc, done: true, result: event.result.content }
                : tc
            )
            const diffs = event.result.diffBefore && event.result.diffAfter
              ? [...(u[msgIdx].diffs ?? []), {
                  filePath: event.result.changedFile ?? '(file)',
                  before:   event.result.diffBefore,
                  after:    event.result.diffAfter,
                }]
              : u[msgIdx].diffs
            u[msgIdx] = { ...u[msgIdx], toolCalls, diffs }
          }
          return u
        })
        break
      }

      case 'usage':
        setTokens(event.tokens)
        break

      case 'error':
        setStatus('error')
        setMessages(prev => {
          const u = [...prev]
          if (u[msgIdx]) u[msgIdx] = { ...u[msgIdx], content: `Error: ${event.message}`, isStreaming: false }
          return u
        })
        break

      case 'done':
        setMessages(prev => {
          const u = [...prev]
          if (u[msgIdx]) u[msgIdx] = { ...u[msgIdx], isStreaming: false }
          return u
        })
        break
    }
  }

  return (
    <Box flexDirection="column" height="100%">
      <Box flexGrow={1}>
        <FileTree tree={tree} changedFiles={changedFiles} />
        <ChatPanel
          messages={messages}
          input={input}
          isThinking={status === 'thinking'}
          onInput={setInput}
          onSubmit={handleSubmit}
        />
      </Box>
      <StatusBar model={model} cwd={cwd} status={status} tokens={tokens} />
    </Box>
  )
}

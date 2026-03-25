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

  const handleSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return
    setInput('')

    // ── Slash commands ──────────────────────────────────────────────────────
    if (trimmed === '/exit' || trimmed === '/quit') {
      exit()
      return
    }
    if (trimmed === '/clear') {
      agent.clearHistory()
      setMessages([])
      setChangedFiles(new Set())
      return
    }
    if (trimmed === '/context') {
      const ctx = agent.getContext()
      setMessages(prev => [...prev, {
        role:    'system',
        content: `Context: ${ctx.files.size} files indexed\n${ctx.tree.slice(0, 500)}`,
      }])
      return
    }
    if (trimmed === '/models') {
      setMessages(prev => [...prev, {
        role:    'system',
        content: models.length ? `Available models:\n${models.map(m => `  • ${m}`).join('\n')}` : 'No models found',
      }])
      return
    }
    if (trimmed.startsWith('/model ')) {
      const newModel = trimmed.slice(7).trim()
      agent.setModel(newModel)
      setModel(newModel)
      setMessages(prev => [...prev, { role: 'system', content: `Switched to model: ${newModel}` }])
      return
    }

    // ── Regular message ─────────────────────────────────────────────────────
    setMessages(prev => [...prev, { role: 'user', content: trimmed }])
    setStatus('thinking')

    // Placeholder assistant message for streaming
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
        const updated = [...prev]
        updated[assistantIdx] = { ...updated[assistantIdx], content: `Error: ${err.message}`, isStreaming: false }
        return updated
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
          const updated = [...prev]
          if (updated[msgIdx]) {
            updated[msgIdx] = { ...updated[msgIdx], content: (updated[msgIdx].content ?? '') + event.content }
          }
          return updated
        })
        break

      case 'tool_start':
        setMessages(prev => {
          const updated = [...prev]
          if (updated[msgIdx]) {
            const toolCalls = [...(updated[msgIdx].toolCalls ?? []), { name: event.name, args: event.args, done: false }]
            updated[msgIdx] = { ...updated[msgIdx], toolCalls }
          }
          return updated
        })
        break

      case 'tool_end': {
        if (event.result.changedFile) newChanged.add(event.result.changedFile)

        setMessages(prev => {
          const updated = [...prev]
          if (updated[msgIdx]) {
            const toolCalls = (updated[msgIdx].toolCalls ?? []).map(tc =>
              tc.name === event.name && !tc.done
                ? { ...tc, done: true, result: event.result.content }
                : tc
            )
            const diffs = event.result.diffBefore && event.result.diffAfter
              ? [...(updated[msgIdx].diffs ?? []), {
                  filePath: event.result.changedFile ?? '(file)',
                  before:   event.result.diffBefore,
                  after:    event.result.diffAfter,
                }]
              : updated[msgIdx].diffs

            updated[msgIdx] = { ...updated[msgIdx], toolCalls, diffs }
          }
          return updated
        })
        break
      }

      case 'error':
        setStatus('error')
        setMessages(prev => {
          const updated = [...prev]
          if (updated[msgIdx]) {
            updated[msgIdx] = { ...updated[msgIdx], content: `Error: ${event.message}`, isStreaming: false }
          }
          return updated
        })
        break

      case 'done':
        setMessages(prev => {
          const updated = [...prev]
          if (updated[msgIdx]) {
            updated[msgIdx] = { ...updated[msgIdx], isStreaming: false }
          }
          return updated
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
      <StatusBar model={model} cwd={cwd} status={status} />
    </Box>
  )
}

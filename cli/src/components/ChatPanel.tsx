import React from 'react'
import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'
import { DiffView } from './DiffView.js'
import { ToolCallBadge } from './ToolCallBadge.js'

export interface ChatMessage {
  role:        'user' | 'assistant' | 'system'
  content:     string
  toolCalls?:  Array<{ name: string; args: Record<string, any>; result?: string; done?: boolean }>
  diffs?:      Array<{ filePath: string; before: string; after: string }>
  isStreaming?: boolean
}

interface Props {
  messages:    ChatMessage[]
  input:       string
  isThinking:  boolean
  onInput:     (val: string) => void
  onSubmit:    (val: string) => void
}

export function ChatPanel({ messages, input, isThinking, onInput, onSubmit }: Props) {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {/* Message history */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {messages.map((msg, i) => (
          <Box key={i} flexDirection="column" marginBottom={1}>
            {/* Role label */}
            <Text bold color={msg.role === 'user' ? 'blue' : 'green'}>
              {msg.role === 'user' ? '▶ You' : '✦ AI'}
            </Text>

            {/* Message content */}
            {msg.content && (
              <Box marginLeft={2}>
                <Text>{msg.content}{msg.isStreaming ? '▌' : ''}</Text>
              </Box>
            )}

            {/* Tool call badges */}
            {msg.toolCalls?.map((tc, j) => (
              <ToolCallBadge
                key={j}
                name={tc.name}
                args={tc.args}
                done={tc.done}
                result={tc.result}
              />
            ))}

            {/* Diffs */}
            {msg.diffs?.map((d, j) => (
              <DiffView key={j} filePath={d.filePath} before={d.before} after={d.after} />
            ))}
          </Box>
        ))}

        {isThinking && (
          <Box marginLeft={2}>
            <Text color="yellow">◌ thinking...</Text>
          </Box>
        )}
      </Box>

      {/* Input */}
      <Box borderStyle="single" borderColor="cyan" paddingX={1} marginTop={1}>
        <Text color="cyan">{'> '}</Text>
        <TextInput
          value={input}
          onChange={onInput}
          onSubmit={onSubmit}
          placeholder="Type a message... (/model <id> | /models | /clear | /exit)"
        />
      </Box>
    </Box>
  )
}

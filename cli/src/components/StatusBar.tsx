import React from 'react'
import { Box, Text } from 'ink'

interface Props {
  model:   string
  cwd:     string
  status:  'idle' | 'thinking' | 'streaming' | 'error'
  tokens?: number
}

const STATUS_LABELS: Record<Props['status'], string> = {
  idle:      '●  ready',
  thinking:  '◌  thinking...',
  streaming: '▶  streaming',
  error:     '✖  error',
}

const STATUS_COLORS: Record<Props['status'], string> = {
  idle:      'green',
  thinking:  'yellow',
  streaming: 'cyan',
  error:     'red',
}

export function StatusBar({ model, cwd, status, tokens }: Props) {
  const label = STATUS_LABELS[status]
  const color = STATUS_COLORS[status]
  const dir   = cwd.replace(process.env.HOME ?? '', '~')

  return (
    <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
      <Text bold color="cyan">⚡ {model}</Text>
      <Text>  |  </Text>
      <Text color="gray">{dir}</Text>
      {tokens !== undefined && (
        <>
          <Text>  |  </Text>
          <Text color="gray">{tokens.toLocaleString()} tokens</Text>
        </>
      )}
      <Text>  |  </Text>
      <Text color={color as any}>{label}</Text>
    </Box>
  )
}

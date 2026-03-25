import React from 'react'
import { Box, Text } from 'ink'
import { createPatch } from 'diff'

interface Props {
  filePath: string
  before:   string
  after:    string
}

export function DiffView({ filePath, before, after }: Props) {
  const patch = createPatch(filePath, before, after, '', '', { context: 3 })
  const lines = patch.split('\n').slice(4) // skip file header lines

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
      <Text bold color="cyan">Diff: {filePath}</Text>
      {lines.map((line, i) => {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          return <Text key={i} color="green">{line}</Text>
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
          return <Text key={i} color="red">{line}</Text>
        }
        if (line.startsWith('@@')) {
          return <Text key={i} color="cyan">{line}</Text>
        }
        return <Text key={i} color="gray">{line}</Text>
      })}
    </Box>
  )
}

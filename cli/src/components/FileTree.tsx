import React from 'react'
import { Box, Text } from 'ink'

interface Props {
  tree:         string
  changedFiles: Set<string>
}

export function FileTree({ tree, changedFiles }: Props) {
  const lines = tree.split('\n').slice(0, 40)

  return (
    <Box
      flexDirection="column"
      width={24}
      borderStyle="single"
      borderRight
      borderLeft={false}
      borderTop={false}
      borderBottom={false}
      paddingX={1}
    >
      <Text bold color="cyan">Files</Text>
      {lines.map((line, i) => {
        const name     = line.trim().replace(/^📁\s*/, '').replace(/\/$/, '')
        const changed  = [...changedFiles].some(f => f.includes(name))
        return (
          <Text key={i} color={changed ? 'yellow' : 'gray'} wrap="truncate-end">
            {line}{changed ? ' *' : ''}
          </Text>
        )
      })}
      {lines.length === 0 && <Text color="gray">(empty)</Text>}
    </Box>
  )
}

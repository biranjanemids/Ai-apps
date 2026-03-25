import React from 'react'
import { Box, Text } from 'ink'

interface Props {
  name:   string
  args:   Record<string, any>
  done?:  boolean
  result?: string
}

const TOOL_ICONS: Record<string, string> = {
  read_file:       '📖',
  write_file:      '✏️ ',
  edit_file:       '🖊️ ',
  list_files:      '📂',
  run_command:     '⚡',
  search_codebase: '🔍',
}

function formatArgs(name: string, args: Record<string, any>): string {
  if (args.path)    return args.path
  if (args.command) return args.command
  if (args.query)   return `"${args.query}"`
  return JSON.stringify(args).slice(0, 60)
}

export function ToolCallBadge({ name, args, done, result }: Props) {
  const icon  = TOOL_ICONS[name] ?? '🔧'
  const label = formatArgs(name, args)
  const color = done ? 'green' : 'yellow'

  return (
    <Box flexDirection="column" marginLeft={2} marginY={0}>
      <Box>
        <Text color={color}>{done ? '✔' : '⟳'} </Text>
        <Text bold>{icon} {name}</Text>
        <Text color="gray"> ({label})</Text>
      </Box>
      {done && result && (
        <Box marginLeft={4}>
          <Text color="gray" wrap="truncate-end">
            {result.split('\n')[0].slice(0, 80)}
          </Text>
        </Box>
      )}
    </Box>
  )
}

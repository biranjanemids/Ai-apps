import { fileTools } from './files.js'
import { runCommand } from './shell.js'
import { searchCodebase } from './search.js'

// OpenAI function-calling definitions
export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name:        'read_file',
      description: 'Read the full contents of a file.',
      parameters:  {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'list_files',
      description: 'List files in a directory. Supports glob patterns.',
      parameters:  {
        type: 'object',
        properties: {
          dir:     { type: 'string', description: 'Directory to list (default: project root)' },
          pattern: { type: 'string', description: 'Glob pattern (default: **/*)'             },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'write_file',
      description: 'Create or overwrite a file with new content.',
      parameters:  {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'File path relative to the project root' },
          content: { type: 'string', description: 'Full file content'                      },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'edit_file',
      description: 'Replace an exact string in a file. Prefer this over write_file for targeted edits.',
      parameters:  {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'File path relative to the project root'     },
          old_str: { type: 'string', description: 'Exact string to find (must be unique)'      },
          new_str: { type: 'string', description: 'String to replace it with'                  },
        },
        required: ['path', 'old_str', 'new_str'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'run_command',
      description: 'Execute a shell command in the project directory.',
      parameters:  {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd:     { type: 'string', description: 'Working directory (default: project root)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'search_codebase',
      description: 'Search for a pattern across all project files using grep/ripgrep.',
      parameters:  {
        type: 'object',
        properties: {
          query:     { type: 'string', description: 'Search pattern or keyword'          },
          file_glob: { type: 'string', description: 'Limit to files matching this glob' },
        },
        required: ['query'],
      },
    },
  },
]

export type ToolResult = { content: string; diffBefore?: string; diffAfter?: string; changedFile?: string }

export function executeTool(
  name: string,
  args: Record<string, any>,
  cwd:  string,
): ToolResult {
  switch (name) {
    case 'read_file': {
      const content = fileTools.read_file(args as any, cwd)
      return { content }
    }
    case 'list_files': {
      const content = fileTools.list_files(args as any, cwd)
      return { content }
    }
    case 'write_file': {
      const r = fileTools.write_file(args as any, cwd)
      return {
        content:     r.message,
        diffBefore:  r.before,
        diffAfter:   r.after,
        changedFile: r.ok ? (args.path as string) : undefined,
      }
    }
    case 'edit_file': {
      const r = fileTools.edit_file(args as any, cwd)
      return {
        content:     r.message,
        diffBefore:  r.before,
        diffAfter:   r.after,
        changedFile: r.ok ? (args.path as string) : undefined,
      }
    }
    case 'run_command': {
      const r = runCommand(args as any, cwd)
      const content = [
        r.stdout ? `stdout:\n${r.stdout}` : '',
        r.stderr ? `stderr:\n${r.stderr}` : '',
        `exit code: ${r.exitCode}`,
      ].filter(Boolean).join('\n')
      return { content }
    }
    case 'search_codebase': {
      const content = searchCodebase(args as any, cwd)
      return { content }
    }
    default:
      return { content: `Unknown tool: ${name}` }
  }
}

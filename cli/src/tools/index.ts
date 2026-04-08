import { fileTools }      from './files.js'
import { runCommand }      from './shell.js'
import { searchCodebase }  from './search.js'
import { gitTools }        from './git.js'
import { fetchUrl }        from './web.js'

// ── OpenAI function-calling definitions (13 tools) ───────────────────────────

export const TOOL_DEFINITIONS = [
  // ── File operations ──────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name:        'read_file',
      description: 'Read the full contents of a file. Always read before editing.',
      parameters:  {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root' },
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
          pattern: { type: 'string', description: 'Glob pattern e.g. "src/**/*.ts" (default: **/*)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'write_file',
      description: 'Create or fully overwrite a file. Use only for new files or complete rewrites.',
      parameters:  {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'File path relative to project root' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'edit_file',
      description: 'Replace an exact string in a file. Preferred over write_file for targeted edits. The old_str must match exactly.',
      parameters:  {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'File path relative to project root' },
          old_str: { type: 'string', description: 'Exact string to find (must be unique in the file)' },
          new_str: { type: 'string', description: 'Replacement string' },
        },
        required: ['path', 'old_str', 'new_str'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'create_directory',
      description: 'Create a directory (and any missing parent directories).',
      parameters:  {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to project root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'delete_file',
      description: 'Delete a file. Use with caution — this is irreversible.',
      parameters:  {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root' },
        },
        required: ['path'],
      },
    },
  },
  // ── Shell ─────────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name:        'run_command',
      description: 'Execute a shell command in the project directory. Use to run tests, builds, linters, installers.',
      parameters:  {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd:     { type: 'string', description: 'Working directory override (default: project root)' },
        },
        required: ['command'],
      },
    },
  },
  // ── Search ────────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name:        'search_codebase',
      description: 'Search for a pattern across all project files (ripgrep). Returns up to 50 matches with 2 lines of context.',
      parameters:  {
        type: 'object',
        properties: {
          query:            { type: 'string',  description: 'Search pattern or keyword' },
          file_glob:        { type: 'string',  description: 'Limit to files matching glob e.g. "*.ts"' },
          file_type:        { type: 'string',  description: 'File type filter e.g. "ts", "py", "js"' },
          case_insensitive: { type: 'boolean', description: 'Case-insensitive search (default: false)' },
        },
        required: ['query'],
      },
    },
  },
  // ── Git ───────────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name:        'git_status',
      description: 'Show current git branch and working tree status.',
      parameters:  { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name:        'git_diff',
      description: 'Show git diff against HEAD (or staged changes). Optionally scope to a specific file.',
      parameters:  {
        type: 'object',
        properties: {
          file:   { type: 'string',  description: 'Specific file to diff (optional)' },
          staged: { type: 'boolean', description: 'Show staged diff (--cached) instead of working tree' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'git_log',
      description: 'Show recent git commit history.',
      parameters:  {
        type: 'object',
        properties: {
          n: { type: 'number', description: 'Number of commits to show (default: 10, max: 50)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'git_commit',
      description: 'Stage all changes (git add -A) and create a commit.',
      parameters:  {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message' },
        },
        required: ['message'],
      },
    },
  },
  // ── Web ───────────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name:        'fetch_url',
      description: 'Fetch a URL and return its text content. Useful for reading API docs, READMEs, or Stack Overflow answers.',
      parameters:  {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'HTTP/HTTPS URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
]

// ── Tool result type ──────────────────────────────────────────────────────────

export interface ToolResult {
  content:      string
  diffBefore?:  string
  diffAfter?:   string
  changedFile?: string
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  args: Record<string, any>,
  cwd:  string,
): Promise<ToolResult> {
  switch (name) {
    case 'read_file':
      return { content: fileTools.read_file(args as any, cwd) }

    case 'list_files':
      return { content: fileTools.list_files(args as any, cwd) }

    case 'write_file': {
      const r = fileTools.write_file(args as any, cwd)
      return { content: r.message, diffBefore: r.before, diffAfter: r.after, changedFile: r.ok ? args.path : undefined }
    }

    case 'edit_file': {
      const r = fileTools.edit_file(args as any, cwd)
      return { content: r.message, diffBefore: r.before, diffAfter: r.after, changedFile: r.ok ? args.path : undefined }
    }

    case 'create_directory':
      return { content: fileTools.create_directory(args as any, cwd) }

    case 'delete_file':
      return { content: fileTools.delete_file(args as any, cwd) }

    case 'run_command': {
      const r = runCommand(args as any, cwd)
      const content = [
        r.stdout ? `stdout:\n${r.stdout}` : '',
        r.stderr ? `stderr:\n${r.stderr}` : '',
        `exit code: ${r.exitCode}`,
      ].filter(Boolean).join('\n')
      return { content }
    }

    case 'search_codebase':
      return { content: searchCodebase(args as any, cwd) }

    case 'git_status':
      return { content: gitTools.git_status({} as any, cwd) }

    case 'git_diff':
      return { content: gitTools.git_diff(args as any, cwd) }

    case 'git_log':
      return { content: gitTools.git_log(args as any, cwd) }

    case 'git_commit':
      return { content: gitTools.git_commit(args as any, cwd) }

    case 'fetch_url':
      return { content: await fetchUrl(args as any) }

    default:
      return { content: `Unknown tool: ${name}` }
  }
}

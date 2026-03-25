import { readFileSync, existsSync } from 'fs'
import { resolve, relative } from 'path'
import { globSync } from 'glob'
import ignore from 'ignore'

const TEXT_EXTENSIONS = new Set([
  '.ts','.tsx','.js','.jsx','.mjs','.cjs',
  '.py','.rb','.go','.rs','.java','.kt','.swift',
  '.c','.cpp','.h','.hpp','.cs',
  '.html','.css','.scss','.sass','.less',
  '.json','.yaml','.yml','.toml','.ini','.env.example',
  '.md','.mdx','.txt','.sh','.bash','.zsh',
  '.sql','.graphql','.prisma',
])

const MAX_FILE_SIZE  = 50_000   // bytes — skip large files
const MAX_TREE_FILES = 300

export interface ProjectContext {
  tree:     string     // file tree as string
  files:    Map<string, string>  // path → content (key files only)
  cwd:      string
}

export function buildContext(cwd: string): ProjectContext {
  const ig = ignore()

  // Load .gitignore if present
  const gitignorePath = resolve(cwd, '.gitignore')
  if (existsSync(gitignorePath)) {
    ig.add(readFileSync(gitignorePath, 'utf-8'))
  }
  ig.add(['node_modules', '.git', 'dist', 'build', '.next', '*.lock', '*.log'])

  const allFiles = globSync('**/*', {
    cwd,
    nodir:    true,
    maxDepth: 8,
    dot:      false,
  }).filter(f => !ig.ignores(f))

  // File tree (capped)
  const treeFiles = allFiles.slice(0, MAX_TREE_FILES)
  const tree = buildTree(treeFiles)

  // Eagerly read small text files for context
  const files = new Map<string, string>()
  for (const f of allFiles) {
    const ext  = '.' + f.split('.').pop()
    if (!TEXT_EXTENSIONS.has(ext)) continue
    try {
      const full    = resolve(cwd, f)
      const content = readFileSync(full)
      if (content.length > MAX_FILE_SIZE) continue
      files.set(f, content.toString('utf-8'))
    } catch {}
  }

  return { tree, files, cwd }
}

function buildTree(files: string[]): string {
  const dirs = new Set<string>()
  for (const f of files) {
    const parts = f.split('/')
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'))
    }
  }

  const all  = [...dirs, ...files].sort()
  const seen = new Set<string>()
  const lines: string[] = []

  for (const item of all) {
    if (seen.has(item)) continue
    seen.add(item)
    const depth  = item.split('/').length - 1
    const name   = item.split('/').pop()!
    const isDir  = dirs.has(item)
    const prefix = '  '.repeat(depth) + (isDir ? '📁 ' : '  ')
    lines.push(`${prefix}${name}${isDir ? '/' : ''}`)
  }
  return lines.join('\n')
}

/** Score files by relevance to a user message */
export function relevantFiles(ctx: ProjectContext, userMessage: string, limit = 8): Map<string, string> {
  const words   = userMessage.toLowerCase().split(/\W+/).filter(w => w.length > 2)
  const scored  = new Map<string, number>()

  for (const [path] of ctx.files) {
    const pathLower = path.toLowerCase()
    let score = 0
    for (const w of words) {
      if (pathLower.includes(w)) score += 2
    }
    // Boost config / entry files
    if (/index|main|app|config|server/.test(pathLower)) score += 1
    if (score > 0) scored.set(path, score)
  }

  const sorted = [...scored.entries()].sort((a, b) => b[1] - a[1])
  const result = new Map<string, string>()
  for (const [path] of sorted.slice(0, limit)) {
    result.set(path, ctx.files.get(path)!)
  }
  return result
}

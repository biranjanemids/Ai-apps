import { readFileSync, existsSync, statSync } from 'fs'
import { resolve, relative, dirname }         from 'path'
import { globSync }                            from 'glob'
import ignore                                  from 'ignore'

const TEXT_EXTENSIONS = new Set([
  '.ts','.tsx','.js','.jsx','.mjs','.cjs',
  '.py','.rb','.go','.rs','.java','.kt','.swift',
  '.c','.cpp','.h','.hpp','.cs','.php',
  '.html','.css','.scss','.sass','.less',
  '.json','.yaml','.yml','.toml','.ini','.env.example',
  '.md','.mdx','.txt','.sh','.bash','.zsh',
  '.sql','.graphql','.prisma','.proto',
])

const MAX_FILE_SIZE  = 100_000   // 100 KB — skip large files
const MAX_TREE_FILES = 500
const SNIPPET_CHARS  = 8_000     // per file in context (was 3000)

export interface ProjectContext {
  tree:  string
  files: Map<string, string>   // relative path → content
  cwd:   string
}

// ── Build initial project context ─────────────────────────────────────────────

export function buildContext(cwd: string): ProjectContext {
  const ig = ignore()

  const gitignorePath = resolve(cwd, '.gitignore')
  if (existsSync(gitignorePath)) ig.add(readFileSync(gitignorePath, 'utf-8'))
  ig.add(['node_modules', '.git', 'dist', 'build', '.next', '*.lock', '*.log', 'coverage'])

  const allFiles = globSync('**/*', {
    cwd,
    nodir:    true,
    maxDepth: 8,
    dot:      false,
  }).filter(f => !ig.ignores(f))

  const treeFiles = allFiles.slice(0, MAX_TREE_FILES)
  const tree      = buildTree(treeFiles)

  // Load all small text files eagerly
  const files = new Map<string, string>()
  for (const f of allFiles) {
    const ext = '.' + f.split('.').pop()
    if (!TEXT_EXTENSIONS.has(ext)) continue
    try {
      const full = resolve(cwd, f)
      const stat = statSync(full)
      if (stat.size > MAX_FILE_SIZE) continue
      files.set(f, readFileSync(full, 'utf-8'))
    } catch {}
  }

  return { tree, files, cwd }
}

// ── Score files by relevance to a user message ────────────────────────────────

export function relevantFiles(ctx: ProjectContext, userMessage: string, limit = 10): Map<string, string> {
  const words = userMessage
    .toLowerCase()
    .split(/\W+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))

  const scored = new Map<string, number>()

  for (const [path, content] of ctx.files) {
    const pathLower    = path.toLowerCase()
    const contentLower = content.toLowerCase()
    let score = 0

    for (const word of words) {
      // Path match (moderate signal)
      if (pathLower.includes(word)) score += 2
      // Content match (stronger signal)
      if (contentLower.includes(word)) score += 3
    }

    // Boost canonical entry/config files
    if (/\/(index|main|app|server|config|cli)\.[jt]sx?$/.test('/' + path)) score += 2

    // Boost recently modified (within 1 hour)
    try {
      const mtime = statSync(resolve(ctx.cwd, path)).mtimeMs
      if (Date.now() - mtime < 3_600_000) score += 1
    } catch {}

    if (score > 0) scored.set(path, score)
  }

  // Sort by score desc, take top N
  const sorted = [...scored.entries()].sort((a, b) => b[1] - a[1])
  const result = new Map<string, string>()

  for (const [path] of sorted.slice(0, limit)) {
    const content = ctx.files.get(path)!
    // Smart truncation: include full file up to SNIPPET_CHARS
    result.set(path, smartTruncate(content, SNIPPET_CHARS))
  }

  // Expand: also include direct imports of top-scored files
  const extras = new Map<string, string>()
  for (const [path] of [...result.entries()].slice(0, 4)) {
    const content = ctx.files.get(path)!
    for (const imp of extractImports(content, dirname(resolve(ctx.cwd, path)), ctx.cwd)) {
      if (!result.has(imp) && ctx.files.has(imp) && extras.size < 4) {
        extras.set(imp, smartTruncate(ctx.files.get(imp)!, SNIPPET_CHARS))
      }
    }
  }

  for (const [k, v] of extras) result.set(k, v)
  return result
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildTree(files: string[]): string {
  const dirs = new Set<string>()
  for (const f of files) {
    const parts = f.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  const all  = [...new Set([...dirs, ...files])].sort()
  const lines: string[] = []
  for (const item of all) {
    const depth  = item.split('/').length - 1
    const name   = item.split('/').pop()!
    const isDir  = dirs.has(item)
    lines.push('  '.repeat(depth) + (isDir ? `${name}/` : name))
  }
  return lines.join('\n')
}

function smartTruncate(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  // Keep first 60% (imports/structure) + last 10% (end of file)
  const head = Math.floor(maxChars * 0.6)
  const tail = Math.floor(maxChars * 0.1)
  return content.slice(0, head) + '\n// [...truncated...]\n' + content.slice(-tail)
}

function extractImports(content: string, fileDir: string, cwd: string): string[] {
  const paths: string[] = []
  for (const m of content.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '']) {
      const full = resolve(fileDir, m[1] + ext)
      const rel  = relative(cwd, full)
      if (!rel.startsWith('..')) { paths.push(rel); break }
    }
  }
  return paths
}

// Common words to exclude from relevance scoring
const STOP_WORDS = new Set([
  'the','and','for','are','but','not','you','all','can','had','her','was','one',
  'our','out','day','get','has','him','his','how','its','let','may','new','now',
  'old','see','two','way','who','boy','did','she','too','use','with','that','this',
  'from','they','will','been','have','said','each','what','when','which','than',
  'more','also','into','your','some','them','then','these','there','would','could',
])

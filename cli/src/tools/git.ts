import { execSync } from 'child_process'

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch (e: any) {
    const out = [(e.stdout ?? '').toString().trim(), (e.stderr ?? '').toString().trim()].filter(Boolean).join('\n')
    return out || `Error: ${e.message}`
  }
}

export const gitTools = {
  git_status(_args: Record<string, never>, cwd: string): string {
    const branch = run('git rev-parse --abbrev-ref HEAD', cwd)
    const status = run('git status --short', cwd)
    return `Branch: ${branch}\n${status || '(clean working tree)'}`
  },

  git_diff(args: { file?: string; staged?: boolean }, cwd: string): string {
    const target = args.staged ? '--cached' : 'HEAD'
    const path   = args.file ? ` -- "${args.file}"` : ''
    const out    = run(`git diff ${target}${path}`, cwd)
    return out || '(no changes)'
  },

  git_log(args: { n?: number }, cwd: string): string {
    const n = Math.min(args.n ?? 10, 50)
    return run(`git log --oneline --graph --decorate -${n}`, cwd)
  },

  git_commit(args: { message: string }, cwd: string): string {
    if (!args.message?.trim()) return 'Error: commit message is required'
    const add    = run('git add -A', cwd)
    const commit = run(`git commit -m ${JSON.stringify(args.message)}`, cwd)
    return [add, commit].filter(Boolean).join('\n')
  },
}

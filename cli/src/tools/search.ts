import { execSync } from 'child_process'
import { resolve } from 'path'

export function searchCodebase(args: { query: string; file_glob?: string }, cwd: string): string {
  try {
    const glob    = args.file_glob ? `--glob '${args.file_glob}'` : ''
    const escaped = args.query.replace(/'/g, "'\\''")

    // Prefer ripgrep, fall back to grep
    let cmd: string
    try {
      execSync('which rg', { stdio: 'ignore' })
      cmd = `rg --no-heading -n --max-count 5 ${glob} '${escaped}' .`
    } catch {
      cmd = `grep -rn --include='${args.file_glob ?? '*'}' -m 5 '${escaped}' .`
    }

    const out = execSync(cmd, { cwd, encoding: 'utf-8', timeout: 10_000 }).trim()
    return out || '(no matches found)'
  } catch (e: any) {
    const out = (e.stdout ?? '').toString().trim()
    return out || '(no matches found)'
  }
}

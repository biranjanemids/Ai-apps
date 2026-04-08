import { execSync } from 'child_process'

const MAX_OUTPUT = 8_000

export function searchCodebase(
  args: { query: string; file_glob?: string; case_insensitive?: boolean; file_type?: string },
  cwd: string,
): string {
  try {
    const escaped   = args.query.replace(/'/g, "'\\''")
    const caseFlag  = args.case_insensitive ? '--ignore-case' : ''
    const typeFlag  = args.file_type ? `--type ${args.file_type}` : ''
    const globFlag  = args.file_glob ? `--glob '${args.file_glob}'` : ''

    let cmd: string
    try {
      execSync('which rg', { stdio: 'ignore' })
      cmd = `rg --no-heading -n --max-count 50 -C 2 ${caseFlag} ${typeFlag} ${globFlag} '${escaped}' .`.replace(/\s+/g, ' ').trim()
    } catch {
      // Fallback to grep
      const iFlag = args.case_insensitive ? '-i' : ''
      const inc   = args.file_glob ? `--include='${args.file_glob}'` : ''
      cmd = `grep -rn ${iFlag} -m 50 -C 2 ${inc} '${escaped}' .`.replace(/\s+/g, ' ').trim()
    }

    const out = execSync(cmd, { cwd, encoding: 'utf-8', timeout: 15_000 }).trim()
    if (!out) return '(no matches found)'
    return out.length > MAX_OUTPUT ? out.slice(0, MAX_OUTPUT) + '\n[...truncated]' : out
  } catch (e: any) {
    const out = (e.stdout ?? '').toString().trim()
    return out || '(no matches found)'
  }
}

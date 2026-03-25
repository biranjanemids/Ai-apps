import { execSync } from 'child_process'

export interface ShellResult {
  stdout:   string
  stderr:   string
  exitCode: number
}

const BLOCKED = [
  /rm\s+-rf\s+\//, /mkfs/, /dd\s+if=/, /:\(\)\{.*\}/, /fork\s*bomb/,
]

export function runCommand(args: { command: string; cwd?: string }, projectCwd: string): ShellResult {
  const cmd = args.command.trim()

  for (const pattern of BLOCKED) {
    if (pattern.test(cmd)) {
      return { stdout: '', stderr: `Blocked: potentially destructive command`, exitCode: 1 }
    }
  }

  try {
    const stdout = execSync(cmd, {
      cwd:     args.cwd ? args.cwd : projectCwd,
      timeout: 30_000,
      encoding: 'utf-8',
      stdio:   ['pipe', 'pipe', 'pipe'],
    })
    return { stdout: stdout.toString().trim(), stderr: '', exitCode: 0 }
  } catch (e: any) {
    return {
      stdout:   (e.stdout ?? '').toString().trim(),
      stderr:   (e.stderr ?? e.message ?? '').toString().trim(),
      exitCode: e.status ?? 1,
    }
  }
}

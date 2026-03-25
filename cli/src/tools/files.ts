import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { globSync } from 'glob'

export interface EditResult {
  ok:      boolean
  message: string
  before?: string
  after?:  string
}

export const fileTools = {
  read_file(args: { path: string }, cwd: string): string {
    try {
      return readFileSync(resolve(cwd, args.path), 'utf-8')
    } catch (e: any) {
      return `Error reading file: ${e.message}`
    }
  },

  list_files(args: { dir?: string; pattern?: string }, cwd: string): string {
    try {
      const base    = resolve(cwd, args.dir ?? '.')
      const pattern = args.pattern ?? '**/*'
      const files   = globSync(pattern, {
        cwd:      base,
        nodir:    true,
        ignore:   ['node_modules/**', '.git/**', 'dist/**', 'build/**', '.next/**'],
        maxDepth: 6,
      })
      return files.length ? files.slice(0, 200).join('\n') : '(no files matched)'
    } catch (e: any) {
      return `Error listing files: ${e.message}`
    }
  },

  write_file(args: { path: string; content: string }, cwd: string): EditResult {
    try {
      const full = resolve(cwd, args.path)
      let before: string | undefined
      try { before = readFileSync(full, 'utf-8') } catch {}
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, args.content, 'utf-8')
      return { ok: true, message: `Written: ${args.path}`, before, after: args.content }
    } catch (e: any) {
      return { ok: false, message: `Error writing file: ${e.message}` }
    }
  },

  edit_file(args: { path: string; old_str: string; new_str: string }, cwd: string): EditResult {
    try {
      const full   = resolve(cwd, args.path)
      const before = readFileSync(full, 'utf-8')
      if (!before.includes(args.old_str)) {
        return {
          ok:      false,
          message: `old_str not found in ${args.path}. Make sure the string matches exactly.`,
        }
      }
      const after = before.replace(args.old_str, args.new_str)
      writeFileSync(full, after, 'utf-8')
      return { ok: true, message: `Edited: ${args.path}`, before, after }
    } catch (e: any) {
      return { ok: false, message: `Error editing file: ${e.message}` }
    }
  },
}

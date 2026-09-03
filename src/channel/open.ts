import type { OpenRequest } from './index'
import { spawn } from 'node:child_process'
import process from 'node:process'

type Args = (file: string, line?: number, column?: number) => string[]

const goto: Args = (file, line, column) => [line === undefined ? file : `${file}:${line}${column === undefined ? '' : `:${column}`}`]
const gotoFlag: Args = (...args) => ['-g', ...goto(...args)]
const lineFlag: Args = (file, line) => line === undefined ? [file] : ['--line', String(line), file]
const linePlus: Args = (file, line) => line === undefined ? [file] : [`+${line}`, file]

function forEditors(names: string[], args: Args): Record<string, Args> {
  return Object.fromEntries(names.map(name => [name, args]))
}

const EDITORS: Record<string, Args> = {
  ...forEditors(['code', 'code-insiders', 'codium', 'cursor', 'windsurf'], gotoFlag),
  ...forEditors(['zed', 'subl', 'sublime_text', 'atom'], goto),
  ...forEditors(['idea', 'webstorm', 'phpstorm'], lineFlag),
  ...forEditors(['emacs', 'gvim', 'mvim'], linePlus),
  emacsclient: (file, line) => line === undefined ? [file] : ['-n', `+${line}`, file],
}

/** Editors that need a terminal; spawning them detached would open nothing visible. */
const TERMINAL_EDITORS = new Set(['vi', 'vim', 'nvim', 'nano', 'pico', 'micro', 'hx', 'helix', 'kak', 'joe', 'ne', 'emacs -nw', 'ed'])

/**
 * Open a file in the user's editor. Uses `LAUNCH_EDITOR`, `VISUAL` or `EDITOR`
 * when set, passing the line and column for editors we know how to drive. Falls
 * back to the OS default application (via `tiny-open` if installed, otherwise
 * `open` / `xdg-open` / `start`), which cannot jump to a line.
 */
export async function openInEditor(request: OpenRequest): Promise<boolean> {
  const configured = process.env.LAUNCH_EDITOR || process.env.VISUAL || process.env.EDITOR
  if (configured) {
    const [bin = '', ...extra] = configured.trim().split(/\s+/)
    const name = bin.replace(/\.(?:exe|cmd|bat)$/i, '').split(/[\\/]/).pop()!.toLowerCase()
    if (!TERMINAL_EDITORS.has(name)) {
      const args = EDITORS[name] ?? goto
      return run(bin, [...extra, ...args(request.file, request.line, request.column)])
    }
  }
  const tinyOpen = await import('tiny-open' as string).then(mod => mod.default ?? mod).catch(() => undefined)
  if (typeof tinyOpen === 'function') {
    return tinyOpen(request.file).then(Boolean, () => false)
  }
  if (process.platform === 'darwin') {
    return run('open', [request.file])
  }
  if (process.platform === 'win32') {
    return run('cmd.exe', ['/c', 'start', '', request.file])
  }
  return run('xdg-open', [request.file])
}

function run(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(bin, args, { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
      child.once('error', () => resolve(false))
      child.once('spawn', () => {
        child.unref()
        resolve(true)
      })
    }
    catch {
      resolve(false)
    }
  })
}

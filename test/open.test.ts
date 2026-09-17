import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { openInEditor } from '../src/channel'

let spawns: unknown[][] | undefined

function recordSpawns(): unknown[][] {
  spawns = []
  onTestFinished(() => {
    spawns = undefined
  })
  return spawns
}

function stubPlatform(platform: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
  onTestFinished(() => {
    Object.defineProperty(process, 'platform', descriptor)
  })
}

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: (...args: Parameters<typeof original.spawn>) => {
      if (!spawns) {
        return original.spawn(...args)
      }
      spawns.push(args)
      return { once: (event: string, listener: () => void) => void (event === 'spawn' && queueMicrotask(listener)), unref: () => {} } as unknown as ReturnType<typeof original.spawn>
    },
  }
})

afterEach(() => vi.unstubAllEnvs())

describe('openInEditor', () => {
  it('passes goto arguments for known editors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'my-bad-'))
    const log = join(dir, 'args.txt')
    const bin = join(dir, 'code')
    await writeFile(bin, `#!/bin/sh\necho "$@" > ${log}\n`, { mode: 0o755 })
    vi.stubEnv('LAUNCH_EDITOR', bin)
    expect(await openInEditor({ file: '/proj/a.ts', line: 3, column: 9 })).toBe(true)
    await vi.waitFor(async () => {
      expect((await readFile(log, 'utf8')).trim()).toBe('-g /proj/a.ts:3:9')
    }, { timeout: 5000 })
  })

  it('resolves false when the editor cannot be spawned', async () => {
    vi.stubEnv('LAUNCH_EDITOR', 'definitely-not-an-editor-binary')
    expect(await openInEditor({ file: '/proj/a.ts' })).toBe(false)
  })
})

describe('windows fallback', () => {
  it('opens the file without a shell or a command line', async () => {
    const spawns = recordSpawns()
    stubPlatform('win32')
    vi.stubEnv('LAUNCH_EDITOR', '')
    vi.stubEnv('VISUAL', '')
    vi.stubEnv('EDITOR', '')

    expect(await openInEditor({ file: String.raw`C:\proj\a&calc.exe` })).toBe(true)
    expect(spawns).toHaveLength(1)
    const [bin, args, options] = spawns[0] as [string, string[], { shell?: boolean }]
    expect(bin).toBe('rundll32.exe')
    expect(args).toEqual(['url.dll,FileProtocolHandler', String.raw`C:\proj\a&calc.exe`])
    expect(options.shell).toBeFalsy()
    expect(bin).not.toContain('cmd')
    for (const arg of args.slice(0, -1)) {
      expect(arg).not.toContain('calc.exe')
    }
  })
})

describe('terminal editors', () => {
  it('does not treat a terminal editor as a launchable editor', async () => {
    vi.stubEnv('EDITOR', 'nvim')
    vi.stubEnv('LAUNCH_EDITOR', '')
    vi.stubEnv('VISUAL', '')
    vi.stubEnv('PATH', '/nonexistent')
    // With no OS opener on PATH the fallback fails cleanly; a detached `nvim` would have reported true.
    expect(await openInEditor({ file: '/proj/a.ts', line: 1 })).toBe(false)
  })
})

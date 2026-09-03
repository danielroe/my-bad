import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openInEditor } from '../src/channel'

afterEach(() => vi.unstubAllEnvs())

describe('openInEditor', () => {
  it('passes goto arguments for known editors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'my-bad-'))
    const log = join(dir, 'args.txt')
    const bin = join(dir, 'code')
    await writeFile(bin, `#!/bin/sh\necho "$@" > ${log}\n`, { mode: 0o755 })
    vi.stubEnv('LAUNCH_EDITOR', bin)
    expect(await openInEditor({ file: '/proj/a.ts', line: 3, column: 9 })).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect((await readFile(log, 'utf8')).trim()).toBe('-g /proj/a.ts:3:9')
  })

  it('resolves false when the editor cannot be spawned', async () => {
    vi.stubEnv('LAUNCH_EDITOR', 'definitely-not-an-editor-binary')
    expect(await openInEditor({ file: '/proj/a.ts' })).toBe(false)
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

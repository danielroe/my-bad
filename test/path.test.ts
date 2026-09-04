import { describe, expect, it, vi } from 'vitest'
import { sourceMapLoader } from '../src'
import { dirname, displayPath, hasScheme, isFilePath, relativeToCwd, resolvePath, toPath } from '../src/report/path'

const windowsFile = 'C:\\Users\\me\\project\\nuxt.config.ts'

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  readFile: vi.fn(async (file: string) => file === windowsFile ? 'export default {}\n' : undefined),
}))

describe('native windows paths', () => {
  it('recognises drive-letter paths written with backslashes', () => {
    expect(isFilePath(windowsFile)).toBe(true)
    expect(isFilePath('C:/Users/me/project/nuxt.config.ts')).toBe(true)
    expect(isFilePath('\\\\server\\share\\app.vue')).toBe(true)
    expect(isFilePath('virtual:my-module')).toBe(false)
    expect(isFilePath('./app.vue')).toBe(false)
  })

  it('does not mistake a drive letter for a URL scheme', () => {
    expect(hasScheme(windowsFile)).toBe(false)
    expect(hasScheme('file:///C:/app.vue')).toBe(true)
    expect(hasScheme('virtual:my-module')).toBe(true)
  })

  it('displays them relative to a native cwd', () => {
    expect(relativeToCwd(windowsFile, 'C:\\Users\\me\\project')).toBe('./nuxt.config.ts')
    expect(displayPath(windowsFile, 'C:\\Users\\me\\project')).toBe('nuxt.config.ts')
    expect(displayPath('C:\\p\\node_modules\\vue\\dist\\vue.mjs')).toBe('…/vue/dist/vue.mjs')
    expect(dirname(windowsFile)).toBe('C:/Users/me/project')
  })

  it('resolves and unwraps them without rewriting them', () => {
    expect(resolvePath('C:\\Users\\me\\project', windowsFile)).toBe(windowsFile)
    expect(resolvePath('C:\\Users\\me\\project', './nuxt.config.ts')).toBe('C:/Users/me/project/nuxt.config.ts')
    expect(toPath('file:///C:/Users/me/project/nuxt.config.ts')).toBe('C:/Users/me/project/nuxt.config.ts')
  })

  it('reads sources for them from disk', async () => {
    const loader = sourceMapLoader({ getSourceMap: () => undefined })
    expect(await loader.read!(windowsFile)).toBe('export default {}\n')
  })
})

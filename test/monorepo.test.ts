import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createReport, renderAnsi } from '../src'
import { nuxtPreset } from '../src/presets'
import { externalPackage, resolvePackage } from '../src/report/package'

const root = fileURLToPath(new URL('./fixtures/monorepo/', import.meta.url))
const cwd = `${root}playground`
const framework = `${root}packages/nuxt/dist/app/composables/error.js`

function errorFrom(stack: string): Error {
  const error = new Error('hi')
  error.stack = `Error: hi\n${stack}`
  return error
}

const stack = [
  `    at createError (${framework}:2:9)`,
  `    at setup (${cwd}/pages/index.vue:2:1)`,
].join('\n')

describe('workspace-linked framework packages', () => {
  it('resolves the nearest package for a file outside cwd', () => {
    expect(resolvePackage(framework)).toEqual({ dir: `${root}packages/nuxt`, name: 'nuxt' })
    expect(externalPackage(framework, cwd)).toMatchObject({ name: 'nuxt', displayFile: '…/nuxt/dist/app/composables/error.js' })
    expect(externalPackage(`${cwd}/pages/index.vue`, cwd)).toBeUndefined()
    expect(externalPackage(`${cwd}/node_modules/vue/dist/vue.mjs`, cwd)).toBeUndefined()
    expect(externalPackage('virtual:my-module', cwd)).toBeUndefined()
  })

  it('displays framework frames relative to their package root', async () => {
    const report = await createReport(errorFrom(stack), { cwd, presets: [nuxtPreset()] })
    expect(report.frames[0]!.displayFile).toBe('…/nuxt/dist/app/composables/error.js')
    expect(report.frames[1]!.displayFile).toBeUndefined()

    const ansi = renderAnsi(report, { cwd, colors: false, hyperlinks: false, verbose: true })
    expect(ansi).toContain('…/nuxt/dist/app/composables/error.js:2:9')
    expect(ansi).not.toContain(root)
  })

  it('classifies them as framework internals rather than app code', async () => {
    const report = await createReport(errorFrom(stack), { cwd, presets: [nuxtPreset()] })
    expect(report.frames.map(frame => frame.type)).toEqual(['internal', 'app'])
    expect(report.frames[1]!.snippet).toBeDefined()
    expect(renderAnsi(report, { cwd, colors: false, hyperlinks: false })).toContain('1 framework frame')
  })

  it('collapses the throwing frame by function name when the path is unknown', async () => {
    const report = await createReport(errorFrom('    at createError (virtual:nuxt/error.js:1:1)'), { cwd, presets: [nuxtPreset()] })
    expect(report.frames[0]!.type).toBe('internal')
  })
})

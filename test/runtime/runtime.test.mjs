import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
const fixture = fileURLToPath(new URL('../fixtures/basic/', import.meta.url))

it('imports every public entry', async () => {
  for (const file of Object.values(pkg.publishConfig.exports)) {
    if (file.endsWith('.mjs')) {
      await import(new URL(`../../${file}`, import.meta.url).href)
    }
  }
})

it('maps a thrown error through a sidecar source map', async () => {
  const { createReport } = await import('../../dist/index.mjs')
  const { makeWidget } = await import('../fixtures/basic/dist/sidecar/thrower.mjs')
  let error
  try {
    makeWidget('')
  }
  catch (e) {
    error = e
  }
  const report = await createReport(error, { cwd: fixture })
  assert.equal(report.message, 'Widget needs a name')
  assert.equal(report.frames[0].file, `${fixture}src/thrower.ts`)
  assert.equal(report.frames[0].line, 4)
})

import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { consola } from 'consola'
import { createReport, renderAnsi } from '../dist/index.mjs'

const fixtures = fileURLToPath(new URL('../test/fixtures/basic/', import.meta.url))
const { stdout } = await promisify(execFile)(process.execPath, [`${fixtures}run.mjs`, 'sidecar', 'withCause'])
function revive(data: any): Error {
  const error = new Error(data.message, data.cause ? { cause: revive(data.cause) } : undefined)
  error.name = data.name
  error.stack = data.stack
  return error
}
const error = revive(JSON.parse(stdout))
const report = await createReport(error, { cwd: fixtures })
const ansi = renderAnsi(report, { cwd: fixtures, colors: true, width: 90 })

console.log('\n--- consola.error(renderAnsi(report, { icon: false })) ---')
consola.error(renderAnsi(report, { cwd: fixtures, colors: true, width: 90, icon: false }))
console.log('\n--- consola.error(error) (raw, for comparison) ---')
consola.error(error)
console.log('\n--- consola.log(string) ---')
consola.log(ansi)

console.log('\n--- consola.error({ badge: false, message }) with our icon: false ---')
consola.error({ badge: false, message: renderAnsi(report, { cwd: fixtures, colors: true, width: 90, icon: false }) })

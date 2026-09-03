import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createReport } from '../dist/index.mjs'

export const fixtures = fileURLToPath(new URL('../test/fixtures/basic/', import.meta.url))

async function fixtureError(fn: string): Promise<Error> {
  const { stdout } = await promisify(execFile)(process.execPath, [`${fixtures}run.mjs`, 'sidecar', fn])
  const revive = (data: any): Error => {
    const error = new Error(data.message, data.cause ? { cause: revive(data.cause) } : undefined)
    error.name = data.name
    error.stack = data.stack
    return error
  }
  return revive(JSON.parse(stdout))
}

/** A sourcemapped report with every optional field populated, for screenshots and README assets. */
export async function demoReport() {
  const report = await createReport(await fixtureError('withCause'), { cwd: fixtures })
  report.code = 'E1001'
  report.docsUrl = 'https://nuxt.com/docs/errors/e1001'
  report.hint = 'The widget factory received an empty name. Check the `name` prop passed from the parent component.'
  report.trace = [{ label: '<App>', file: `${fixtures}src/app.vue` }, { label: '<NuxtLayout>' }, { label: '<WidgetList>', file: `${fixtures}src/widget-list.vue`, line: 12 }]
  report.sections.push({ id: 'request', title: 'Request', content: { 'method': 'GET', 'url': '/widgets?page=2', 'user-agent': 'Mozilla/5.0' } })
  return report
}

/**
 * Interactive playground. Run `pnpm play`, open the printed URL, then press keys
 * in this terminal to drive the page over the live channel.
 */
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createChannel } from '../dist/channel/index.mjs'
import { createReport, renderAnsi, renderOverlay, renderPage } from '../dist/index.mjs'
import { nuxtPreset, nuxtTheme } from '../dist/presets/index.mjs'
import { fileSink } from '../dist/sinks/index.mjs'

const fixtures = fileURLToPath(new URL('../test/fixtures/basic/', import.meta.url))
const channel = createChannel({ open: true, sink: fileSink(new URL('./out/events.jsonl', import.meta.url).pathname) })
const port = Number(process.env.PORT || 4321)

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

const scenarios = {
  cause: () => fixtureError('withCause'),
  simple: () => fixtureError('makeWidget'),
  http: async () => Object.assign(await fixtureError('makeWidget'), { name: 'HTTPError', statusCode: 418, code: 'E1001', data: { teapot: true } }),
  compile: async () => ({
    name: 'SyntaxError',
    message: 'Element is missing end tag.',
    plugin: 'vite:vue',
    id: `${fixtures}src/app.vue`,
    loc: { file: `${fixtures}src/app.vue`, line: 3, column: 5 },
    frame: '1  |  <template>\n2  |    <div>\n3  |      <p\n   |      ^\n4  |  </template>',
  }),
  aggregate: async () => new AggregateError([await fixtureError('makeWidget'), new RangeError('Out of range')], 'Several things went wrong'),
}

let counter = 0
async function build(name: keyof typeof scenarios) {
  const report = await createReport(await scenarios[name](), {
    cwd: fixtures,
    presets: [nuxtPreset({ versions: { nuxt: '4.2.0', vite: '8.0.0' } })],
    context: {
      event: { req: { method: 'GET', url: `/widgets/${++counter}`, headers: new Headers({ 'accept': 'text/html', 'cookie': 'session=secret', 'user-agent': 'playground' }) } },
      route: { fullPath: `/widgets/${counter}`, name: 'widgets-id', matched: [{ name: 'widgets-id' }], meta: { layout: 'default', middleware: ['auth'] } },
      trace: ' at <WidgetList>\n at <NuxtPage>\n at <App>',
    },
  })
  if (name === 'simple') {
    report.hint = 'The widget factory received an empty name. Check the `name` prop passed from the parent component.'
  }
  return report
}

let current = await build('cause')

const server = createServer(async (req, res) => {
  if (await channel.handler(req, res)) {
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  res.setHeader('content-type', 'text/html; charset=utf-8')
  if (url.pathname === '/overlay') {
    res.end(`<!DOCTYPE html><html><head><title>error.vue</title><style>body{font-family:system-ui;padding:48px;background:#f7f7f5;color:#222}h1{font-size:64px;margin:0}</style></head><body><h1>500</h1><p>This stands in for the user's <code>error.vue</code>.</p><p><a href="/">Full page</a></p>${renderOverlay(current, { cwd: fixtures, channel: '/__my-bad', startMinimized: url.searchParams.has('min'), history: channel.history })}</body></html>`)
    return
  }
  res.end(renderPage(current, { cwd: fixtures, channel: '/__my-bad', history: channel.history, theme: nuxtTheme }))
})

const host = process.argv.includes('--host') ? '0.0.0.0' : '127.0.0.1'
server.listen(port, host, () => {
  console.log(`\n  page     http://localhost:${port}/\n  overlay  http://localhost:${port}/overlay  (add ?min to start minimised)\n`)
  console.log('  keys: [1] cause  [2] simple  [3] http  [4] compile  [5] aggregate  [w] warning  [l] log  [c] clear  [a] print ansi  [q] quit\n')
})

const keys: Record<string, keyof typeof scenarios> = { 1: 'cause', 2: 'simple', 3: 'http', 4: 'compile', 5: 'aggregate' }
process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdin.setEncoding('utf8')
process.stdin.on('data', async (key: string) => {
  if (key === 'q' || key === '\u0003') {
    channel.close()
    server.close()
    process.exit(0)
  }
  if (keys[key]) {
    current = await build(keys[key])
    channel.setError(current)
    console.log(renderAnsi(current, { cwd: fixtures }))
  }
  else if (key === 'w') {
    channel.warn({ ...(await build('simple')), name: 'Vue warn', message: `Extraneous non-props attributes (${counter}) were passed to component but could not be automatically inherited.` })
  }
  else if (key === 'l') {
    const levels = ['info', 'warn', 'error', 'log'] as const
    channel.log({ level: levels[counter++ % levels.length]!, text: `GET /widgets/${counter} ${Math.round(Math.random() * 300)}ms` })
  }
  else if (key === 'c') {
    channel.clearError()
  }
  else if (key === 'a') {
    console.log(renderAnsi(current, { cwd: fixtures, verbose: true }))
  }
})

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ErrorReport } from '../../src/types'
import type { CaseId, LabState, Scenario } from './data.ts'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cp, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer as createNetServer } from 'node:net'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { stripVTControlCharacters } from 'node:util'
import { createServer } from 'vite'
import { createChannel } from '../../dist/channel/index.mjs'
import { createReport, fsLoader, parseInlineSourceMap, sourceMapLoader } from '../../dist/index.mjs'
import { nuxtPreset } from '../../dist/presets/index.mjs'
import { isTrustedNodeRequest } from '../../src/channel/origin.ts'
import { cases } from './data.ts'

const root = import.meta.dirname
const project = resolve(root, '../..')
const runtime = resolve(root, '../out/nuxt-live')
const toolchain = resolve(project, 'test/fixtures/nuxt-v4')
const port = Number(process.env.PORT || 4330)
const portProbe = createNetServer()
await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve))
const nuxtPort = Number(process.env.NUXT_PORT || (portProbe.address() as { port: number }).port)
await new Promise<void>(resolve => portProbe.close(() => resolve()))
const hub = `http://127.0.0.1:${port}`
const upstream = `http://127.0.0.1:${nuxtPort}`
const token = randomBytes(24).toString('hex')
const require = createRequire(`${toolchain}/package.json`)
const nuxtRequire = createRequire(require.resolve('nuxt/package.json'))
const versions = Object.fromEntries(['nuxt', 'vue', 'vite', 'nitropack'].map((name) => {
  try {
    const item = (name === 'nitropack' ? nuxtRequire : require)(`${name}/package.json`)
    return [name === 'nitropack' ? 'Nitro' : name[0]!.toUpperCase() + name.slice(1), item.version]
  }
  catch {
    return [name, 'unavailable']
  }
}))
const faultsTemplate = await readFile(resolve(root, 'nuxt-app/shared/faults.ts'), 'utf8')
const componentTemplate = await readFile(resolve(root, 'nuxt-app/app/components/DirectoryHeader.vue'), 'utf8')
const state: LabState = { cwd: runtime, versions, scenario: 'healthy', run: 1, path: '/app/?case=healthy&run=1', ready: false, busy: false, fixed: false, delay: 0, phase: 'Starting Nuxt', reports: [], archived: [], logs: [] }
const channel = createChannel({ root: runtime, open: true, sink(event) {
  if (event.type === 'log')
    state.logs = [...state.logs.slice(-199), event.payload]
} })
const publish = () => channel.progress({ phase: 'lab', message: state.phase })
const log = (text: string, level: 'info' | 'error' = 'info') => channel.log({ text: stripVTControlCharacters(text).trim(), level })

await mkdir(runtime, { recursive: true })
await cp(resolve(root, 'nuxt-app'), runtime, { recursive: true })
await symlink(resolve(toolchain, 'node_modules'), resolve(runtime, 'node_modules'), 'dir').catch((error) => {
  if (error.code !== 'EEXIST')
    throw error
})
await writeFile(resolve(runtime, 'package.json'), JSON.stringify({ name: 'my-bad-live-playground', private: true, type: 'module' }))
await cp(resolve(project, 'test/fixtures/nuxt-app/runtime'), resolve(runtime, 'runtime'), { recursive: true })
const fixtureHandler = await readFile(resolve(project, 'test/fixtures/nuxt-app/error-handler.ts'), 'utf8')
const marker = '  const accept = String(reqHeaders.accept || \'\')'
if (!fixtureHandler.includes(marker))
  throw new Error('Nuxt fixture handler changed: update the playground capture adapter')
await writeFile(resolve(runtime, 'error-handler.ts'), fixtureHandler.replace('rawStack?: string', 'rawStack?: string, originalError?: Error').replace('await createReport(error,', 'await createReport(captured?.originalError ?? error,').replace('(error as Error).stack = captured.rawStack', '(error as Error).stack = captured.rawStack; if (captured.originalError) captured.originalError.stack = captured.rawStack').replace(marker, `  await fetch(process.env.MY_BAD_HUB + '/__lab/ingest', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lab-token': process.env.MY_BAD_TOKEN! }, body: JSON.stringify({ report, environment: 'Server', route: runtime.path(event) }) }).catch(() => {})\n${marker}`).replace('delete defaultRes.headers[\'content-security-policy\']', 'delete defaultRes.headers[\'content-security-policy\']; defaultRes.headers[\'x-frame-options\'] = \'SAMEORIGIN\'').replace('body: injectOverlay(page.html, report, { cwd, startMinimized: status < 500 }),', 'body: page.html,'))

function revive(input: any): Error {
  const error = input.errors ? new AggregateError(input.errors.map(revive), input.message) : new Error(input.message, input.cause ? { cause: revive(input.cause) } : undefined)
  error.name = input.name || 'Error'
  error.stack = input.stack
  return error
}

function clientLoader() {
  const cache = new Map<string, Promise<string | undefined>>()
  async function getCode(file: string) {
    const filePath = file.startsWith('http') ? new URL(file).pathname : file
    if (!filePath.startsWith('/app/_nuxt/'))
      return
    if (!cache.has(filePath)) {
      cache.set(filePath, fetch(`${upstream}${filePath}`, { signal: AbortSignal.timeout(5000) }).then(response => response.ok ? response.text() : undefined))
    }
    return cache.get(filePath)
  }
  return sourceMapLoader({
    getCode,
    async getSourceMap(file) {
      const code = await getCode(file)
      if (!code)
        return
      const map = parseInlineSourceMap(code)
      if (map)
        return map
      // Vue SFC maps can exceed the core file loader's 8 KB tail scan.
      const data = /\/\/# sourceMappingURL=data:application\/json;base64,(\S+)\s*$/.exec(code)?.[1]
      return data ? JSON.parse(Buffer.from(data, 'base64').toString('utf8')) : undefined
    },
    base(file) {
      const path = decodeURIComponent(new URL(file, hub).pathname).replace('/app/_nuxt/', '')
      return dirname(path.startsWith('@fs/') ? path.slice(3) : resolve(runtime, 'app', path))
    },
  })
}

async function ingest(body: any, client = false) {
  const capturedRun = state.run
  if (body.run !== undefined && Number(body.run) !== state.run)
    return
  const routeRun = body.route ? new URL(body.route, hub).searchParams.get('run') : undefined
  if (routeRun && Number(routeRun) !== state.run)
    return
  const report: ErrorReport = body.report ?? await createReport(body.kind === 'compile' ? body.input : revive(body.input), {
    cwd: runtime,
    kind: body.kind === 'compile' ? 'compile' : body.kind === 'warning' ? 'warning' : 'error',
    presets: [nuxtPreset({ versions })],
    loaders: [clientLoader(), fsLoader()],
    maxCauses: 8,
    context: { trace: body.vueTrace },
  })
  if (capturedRun !== state.run)
    return
  if (body.trace?.length)
    report.trace = body.trace
  if (report.kind === 'warning')
    report.frames = report.frames.filter(frame => !frame.file?.endsWith('/plugins/capture.ts'))
  if (report.kind === 'compile') {
    for (const frame of report.frames) {
      if (frame.file?.startsWith(`${runtime}/`) && !await stat(frame.file).catch(() => undefined)) {
        const candidate = resolve(runtime, 'app', relative(runtime, frame.file))
        if (await stat(candidate).catch(() => undefined))
          frame.file = candidate
      }
    }
  }
  if (report.kind === 'warning' && state.scenario === 'hydration')
    report.name = 'HydrationMismatch'
  const requestURL = new URL(body.route ?? state.path, hub)
  const requestPath = requestURL.pathname.startsWith('/app/') ? requestURL.pathname : `/app${requestURL.pathname}`
  const entry: Scenario = {
    label: cases.find(item => item.id === state.scenario)!.label,
    category: report.kind === 'compile' ? 'Build' : report.kind === 'warning' ? state.scenario === 'hydration' ? 'Hydration' : 'Warning' : report.status === 404 ? 'HTTP' : 'Runtime',
    environment: client ? 'Client' : body.environment ?? 'Server',
    route: `${requestPath}${requestURL.search}`,
    report,
    occurrences: 1,
  }
  const existing = state.reports.find(item => item.report.id === report.id || (report.kind === 'compile' && item.report.kind === 'compile' && item.report.message === report.message && item.report.frames[0]?.file === report.frames[0]?.file))
  if (existing) {
    existing.occurrences++
    report.id = existing.report.id
    existing.report = report
  }
  else {
    state.reports.push(entry)
  }
  state.reports = state.reports.slice(-30)
  state.phase = `${state.reports.length} active ${state.reports.length === 1 ? 'issue' : 'issues'}`
  if (report.kind === 'warning')
    channel.warn(report)
  else channel.setError(report)
  log(`${entry.environment} · ${report.name}: ${report.message.slice(0, 180)}`, report.kind === 'warning' ? 'info' : 'error')
  publish()
}

async function jsonBody(req: IncomingMessage) {
  let data = ''
  for await (const chunk of req) {
    data += chunk
    if (data.length > 512_000)
      throw new Error('Request body too large')
  }
  return data ? JSON.parse(data) : {}
}
function respond(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(data))
}
async function waitForHealth(expected?: boolean, revision?: number) {
  const until = Date.now() + 45_000
  while (Date.now() < until) {
    try {
      const response = await fetch(`${upstream}/app/api/health`, { signal: AbortSignal.timeout(1500) })
      const data = await response.json()
      if (data.ok && (expected === undefined || data.faultEnabled === expected) && (revision === undefined || data.revision === revision))
        return
    }
    catch {}
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error('Nuxt did not become ready. Check the live server logs.')
}
function archive() {
  state.archived = [...state.reports, ...state.archived].slice(0, 60)
  state.reports = []
  channel.clearError()
}
async function prepare(id: CaseId, fix = false) {
  state.busy = true
  state.phase = fix ? 'Saving source fix' : 'Preparing scenario'
  publish()
  try {
    state.run++
    state.scenario = id
    state.fixed = fix || id === 'healthy'
    if (!fix)
      archive()
    await writeFile(resolve(runtime, 'app/components/DirectoryHeader.vue'), componentTemplate)
    await writeFile(resolve(runtime, 'shared/faults.ts'), faultsTemplate.replace('faultEnabled = true', `faultEnabled = ${!state.fixed}`).replace('revision = 0', `revision = ${state.run}`))
    log(`Saved shared/faults.ts · faultEnabled = ${!state.fixed}`)
    await waitForHealth(!state.fixed, state.run)
    if (id === 'compile' && !fix) {
      await writeFile(resolve(runtime, 'app/components/DirectoryHeader.vue'), '<template>\n  <section class="directory-header">\n    <p>Employee directory\n  </section>\n</template>\n')
      log('Saved DirectoryHeader.vue with a missing </p> tag')
    }
    state.path = `/app/?case=${id}&run=${state.run}`
    state.phase = 'Waiting for app render'
  }
  finally {
    state.busy = false
    publish()
  }
}

async function allowedFile(file: unknown): Promise<string> {
  if (typeof file !== 'string')
    throw new Error('A source file is required')
  const target = await realpath(resolve(file))
  const rel = relative(await realpath(runtime), target)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || rel.split(sep).includes('node_modules') || rel.split(sep).includes('.nuxt'))
    throw new Error('Only playground source files can be edited')
  return target
}

const vite = await createServer({
  root,
  configFile: false,
  server: { host: '127.0.0.1', port, strictPort: true, proxy: { '/app': { target: upstream, ws: true } }, watch: { ignored: ['**/nuxt-app/**', '**/playground/out/**'] } },
  plugins: [{ name: 'live-nuxt-playground', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url ?? '/', hub)
      if (!url.pathname.startsWith('/__lab/'))
        return next()
      try {
        if (!isTrustedNodeRequest(req))
          return respond(res, { error: 'Untrusted origin' }, 403)
        if (['/__lab/events', '/__lab/open'].includes(url.pathname)) {
          await channel.handler(req, res)
          return
        }
        if (url.pathname === '/__lab/state' && req.method === 'GET')
          return respond(res, state)
        if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json'))
          return respond(res, { error: 'JSON POST required' }, 405)
        const body = await jsonBody(req)
        if (url.pathname === '/__lab/ingest') {
          if (req.headers['x-lab-token'] !== token)
            return respond(res, { error: 'Unauthorized' }, 403)
          await ingest(body)
        }
        else if (url.pathname === '/__lab/capture') {
          await ingest(body, true)
        }
        else if (url.pathname === '/__lab/run') {
          if (state.busy)
            return respond(res, { error: 'A source update is in progress' }, 409)
          if (!cases.some(item => item.id === body.scenario))
            return respond(res, { error: 'Unknown scenario' }, 400)
          await prepare(body.scenario)
        }
        else if (url.pathname === '/__lab/fix') {
          if (state.busy)
            return respond(res, { error: 'A source update is in progress' }, 409)
          await prepare(state.scenario, true)
        }
        else if (url.pathname === '/__lab/mounted') {
          if (body.run === state.run) {
            state.fixed = !!body.fixed
            if (body.fixed)
              archive()
            state.phase = state.reports.length ? `${state.reports.length} active issues` : 'App rendered successfully'
            publish()
          }
        }
        else if (url.pathname === '/__lab/settings') {
          state.delay = Math.max(0, Math.min(5000, Number(body.delay) || 0))
          publish()
        }
        else if (url.pathname === '/__lab/source') {
          return respond(res, { file: await allowedFile(body.file), content: await readFile(await allowedFile(body.file), 'utf8') })
        }
        else if (url.pathname === '/__lab/save') {
          if (typeof body.content !== 'string' || body.content.length > 100_000)
            return respond(res, { error: 'Invalid source' }, 400)
          const file = await allowedFile(body.file)
          await writeFile(file, body.content)
          log(`Saved ${relative(runtime, file)}`)
          state.phase = 'Source saved · Nuxt HMR is rebuilding'
          publish()
        }
        else {
          return respond(res, { error: 'Unknown action' }, 404)
        }
        respond(res, state)
      }
      catch (error) {
        log(String(error), 'error')
        respond(res, { error: String(error) }, 500)
      }
    })
    server.middlewares.use((req, _res, next) => {
      if (state.delay && req.url?.startsWith('/app/'))
        setTimeout(next, state.delay)
      else next()
    })
  } }],
})
await vite.listen()
const child = spawn(process.execPath, [resolve(toolchain, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', runtime, '--host', '127.0.0.1', '--port', String(nuxtPort)], {
  cwd: runtime,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'development', MY_BAD_DIST: resolve(project, 'dist'), MY_BAD_HUB: hub, MY_BAD_TOKEN: token, MY_BAD_NUXT_VERSION: versions.Nuxt, MY_BAD_VUE_VERSION: versions.Vue, NUXT_TELEMETRY_DISABLED: '1' },
})
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk)
  log(String(chunk))
})
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk)
  log(String(chunk), 'error')
})
child.on('exit', (code) => {
  state.ready = false
  state.phase = `Nuxt stopped (${code})`
  publish()
})
async function close() {
  child.kill('SIGTERM')
  channel.close()
  await vite.close()
  process.exit()
}
process.on('SIGINT', close)
process.on('SIGTERM', close)
console.log(`\nLive prototype playground: ${hub}\nNuxt application: ${upstream}/app/\n`)
void waitForHealth().then(() => {
  state.ready = true
  state.fixed = false
  state.phase = 'Nuxt ready'
  publish()
}).catch((error) => {
  state.phase = String(error)
  publish()
})

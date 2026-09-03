import type { Buffer } from 'node:buffer'
/**
 * Boots one `nuxt dev` per cell of [nuxt 4, nuxt 5] x [`experimental.nitroViteEnvironment`
 * off, on]. The shared app lives in `test/fixtures/nuxt-app` and is copied into
 * the version fixture before each boot, so both cells run identical sources
 * against their own pinned toolchain.
 *
 * The nuxt 5 cells are opt-in because they boot a nightly: set
 * `MY_BAD_TEST_NUXT_V5=1` to run them. Cells whose nuxt version has no
 * `experimental.nitroViteEnvironment` resolver are skipped with a reason.
 */
import type { ChildProcess } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import type { ErrorReport } from '../src/types'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface Cell {
  version: 4 | 5
  nitroViteEnvironment: boolean
}

interface Toolchain {
  root: string
  nuxt: string
  vue: string
  nitroViteEnvironment: { supported: boolean, default: boolean }
}

const appDir = fileURLToPath(new URL('./fixtures/nuxt-app/', import.meta.url))
const sharedFiles = ['app.vue', 'error.vue', 'error-handler.ts', 'nuxt.config.ts', 'composables', 'modules', 'pages', 'plugins', 'runtime', 'server']

const cells: Cell[] = [
  { version: 4, nitroViteEnvironment: false },
  { version: 4, nitroViteEnvironment: true },
  { version: 5, nitroViteEnvironment: false },
  { version: 5, nitroViteEnvironment: true },
]

async function toolchain(version: 4 | 5): Promise<Toolchain> {
  const root = fileURLToPath(new URL(`./fixtures/nuxt-v${version}/`, import.meta.url))
  const [nuxt, vue, schema] = await Promise.all([
    readFile(`${root}node_modules/nuxt/package.json`, 'utf8').then(raw => JSON.parse(raw).version as string),
    readFile(`${root}node_modules/vue/package.json`, 'utf8').then(raw => JSON.parse(raw).version as string),
    import(`${root}node_modules/nuxt/schema.js`) as Promise<{ NuxtConfigSchema: { experimental: Record<string, { $resolve?: (value: unknown, get: (key: string) => unknown) => unknown }> } }>,
  ])
  const resolver = schema.NuxtConfigSchema.experimental.nitroViteEnvironment
  const resolved = await resolver?.$resolve?.(undefined, key => (key === 'builder' ? 'vite' : undefined))
  return { root, nuxt, vue, nitroViteEnvironment: { supported: !!resolver, default: resolved === true } }
}

const toolchains = new Map<4 | 5, Toolchain>(await Promise.all(([4, 5] as const).map(async version => [version, await toolchain(version)] as const)))

function skipReason(cell: Cell): string | undefined {
  const support = toolchains.get(cell.version)!
  if (cell.version === 5 && !process.env.MY_BAD_TEST_NUXT_V5) {
    return 'nuxt 5 cells are opt-in: set MY_BAD_TEST_NUXT_V5=1'
  }
  if (cell.nitroViteEnvironment && !support.nitroViteEnvironment.supported) {
    return `nuxt@${support.nuxt} has no experimental.nitroViteEnvironment option`
  }
}

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

async function waitFor<T>(check: () => Promise<T | undefined>, timeout: number, label: string, fatal?: () => string | undefined): Promise<T> {
  const deadline = Date.now() + timeout
  let last: unknown
  while (Date.now() < deadline) {
    const stop = fatal?.()
    if (stop) {
      throw new Error(`gave up waiting for ${label}: ${stop}`)
    }
    try {
      const result = await check()
      if (result !== undefined) {
        return result
      }
    }
    catch (error) {
      last = error
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ''}`)
}

/**
 * Vitest sets `NODE_ENV=test`, `TEST` and `VITEST`, which the dev server would
 * otherwise inherit. `std-env` reads those as "this is a test run", which drops
 * consola to `warn` and so hides every boot log; the unjs stack also branches on
 * them elsewhere. A dev server should see a development environment.
 */
function devEnv(): Record<string, string | undefined> {
  const { NODE_ENV: _node, TEST: _test, VITEST: _vitest, ...env } = process.env
  return { ...env, NODE_ENV: 'development', CONSOLA_LEVEL: '4' }
}

/** Ask the OS for a free port, so a port already in use cannot look like a slow boot. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  await new Promise(resolve => server.close(resolve))
  return port
}

/** Copy the shared app over the version fixture so both cells share one source of truth. */
async function syncApp(root: string): Promise<void> {
  for (const entry of sharedFiles) {
    await rm(`${root}${entry}`, { recursive: true, force: true })
    await cp(`${appDir}${entry}`, `${root}${entry}`, { recursive: true })
  }
}

describe.each(cells)('nuxt v$version (nitroViteEnvironment: $nitroViteEnvironment)', { timeout: 120_000 }, (cell) => {
  const reason = skipReason(cell)
  if (reason) {
    it.skip(`skipped: ${reason}`, () => {})
    return
  }

  const { root, nuxt: nuxtVersion, vue: vueVersion } = toolchains.get(cell.version)!
  const brokenPage = `${root}pages/broken.vue`
  let dev: ChildProcess
  let url: string

  async function report(path: string, init?: RequestInit): Promise<{ status: number, report: ErrorReport }> {
    const response = await fetch(`${url}${path}`, { ...init, headers: { accept: 'application/json', ...init?.headers } })
    return { status: response.status, report: await response.json() as ErrorReport }
  }

  function frame(result: ErrorReport, suffix: string) {
    return result.frames.find(entry => entry.file?.endsWith(suffix))
  }

  function sourcemapUsage(result: ErrorReport) {
    return result.sections.find(section => section.id === 'sourcemaps')!.content as Record<string, string>
  }

  beforeAll(async () => {
    await syncApp(root)
    const port = await freePort()
    url = `http://127.0.0.1:${port}`
    // `--host` is pinned because an unpinned dev server resolves `localhost` and binds only the
    // first result, which on a dual-stack runner is `::1`, leaving this IPv4 probe refused.
    dev = spawn(process.execPath, [`${root}node_modules/nuxt/bin/nuxt.mjs`, 'dev', '--port', String(port), '--host', '127.0.0.1'], {
      cwd: root,
      env: {
        ...devEnv(),
        NUXT_IGNORE_LOCK: '1',
        NUXT_TELEMETRY_DISABLED: '1',
        MY_BAD_NITRO_VITE_ENVIRONMENT: String(cell.nitroViteEnvironment),
        MY_BAD_NUXT_VERSION: nuxtVersion,
        MY_BAD_VUE_VERSION: vueVersion,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // The pipes are drained as they arrive: an undrained pipe would block the dev server once its buffer filled.
    const output: string[] = []
    const collect = (chunk: Buffer) => {
      output.push(chunk.toString())
      if (output.length > 200) {
        output.shift()
      }
    }
    dev.stdout!.on('data', collect)
    dev.stderr!.on('data', collect)
    let died: string | undefined
    dev.once('exit', (code, signal) => {
      died = `it exited with code ${code}${signal ? ` (${signal})` : ''}`
    })
    dev.once('error', (error) => {
      died = `it could not be spawned: ${error.message}`
    })
    // `fetch failed` alone says nothing: record the status or the underlying code, since a
    // dev server answering 500s and one that never binds otherwise look identical here.
    let seen = 'no response'
    const reachable = async () => {
      const response = await fetch(url).catch((error: Error & { cause?: { code?: string } }) => {
        seen = `${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`
        return undefined
      })
      if (!response) {
        return undefined
      }
      seen = `HTTP ${response.status}`
      return response.ok || undefined
    }
    try {
      await waitFor(reachable, 180_000, 'the Nuxt dev server', () => died)
    }
    catch (error) {
      const tail = output.join('').trimEnd()
      throw new Error(`${(error as Error).message}\nlast seen: ${seen}\n--- nuxt dev output ---\n${tail || '(no output)'}`)
    }
  }, 240_000)

  afterAll(async () => {
    dev?.kill()
    await writeFile(brokenPage, await readFile(`${appDir}pages/broken.vue`, 'utf8'))
  })

  it('renders pages that do not throw', async () => {
    const html = await fetch(url).then(res => res.text())
    expect(html).toContain('fixture index ok')
  })

  it('maps ssr frames back to the original composable and sfc', async () => {
    const { status, report: result } = await report('/boom')
    expect(status).toBe(500)
    expect(result.kind).toBe('error')
    expect(result.message).toBe('boom from boom page')

    log(`[nuxt v${cell.version} nitroViteEnvironment=${cell.nitroViteEnvironment}] sourcemaps: ${JSON.stringify(sourcemapUsage(result))}\nraw stack:\n${result.rawStack}`)

    const composable = result.frames[0]!
    const source = await readFile(`${root}composables/useBoom.ts`, 'utf8')
    expect(composable.file).toBe(`${root}composables/useBoom.ts`)
    expect(source.split('\n')[composable.line! - 1]).toContain('throw new Error(')
    expect(composable.line).toBe(2)
    expect(composable.column).toBe(9)
    expect(composable.snippet!.lines[composable.line! - composable.snippet!.start]).toContain('throw new Error')

    const page = frame(result, 'pages/boom.vue')!
    const sfc = await readFile(`${root}pages/boom.vue`, 'utf8')
    expect(sfc.split('\n')[page.line! - 1]).toBe('useBoom(\'boom page\')')
  })

  it('does not map already-mapped frames a second time', async () => {
    const { report: result } = await report('/boom')
    const composable = result.frames[0]!
    const raw = /composables[/\\]useBoom\.ts:(\d+):(\d+)/.exec(result.rawStack ?? '')
    const rawPosition = raw && { line: Number(raw[1]), column: Number(raw[2]) }

    expect([composable.line, composable.column]).toEqual([2, 9])
    expect(rawPosition).toBeTruthy()
    expect(composable.compiled ?? rawPosition!).toMatchObject(rawPosition!)

    const page = frame(result, 'pages/boom.vue')!
    expect(page.compiled?.line ?? page.line!).toBeGreaterThanOrEqual(page.line!)
    if (page.compiled) {
      expect(page.compiled.snippet, 'compiled snippet comes from the module runner code').toBeDefined()
      const compiledLine = page.compiled.snippet!.lines[page.compiled.line! - page.compiled.snippet!.start]
      expect(compiledLine).toMatch(/__vite_ssr_import|useBoom/)
      expect(page.compiled.snippet!.lines.join('\n')).not.toBe(page.snippet!.lines.join('\n'))
    }
  })

  it('populates the vue component trace', async () => {
    const { report: result } = await report('/boom')
    const labels = result.trace!.map(entry => entry.label)
    expect(labels).toContain('<NuxtPage>')
    expect(labels).toContain('<boom>')
    expect(result.trace!.find(entry => entry.label === '<boom>')!.file).toBe(`${root}pages/boom.vue`)
  })

  it('reports request context and versions', async () => {
    const { report: result } = await report('/boom')
    const sections = Object.fromEntries(result.sections.map(section => [section.id, section.content]))
    expect(sections.request).toMatchObject({ method: 'GET', url: '/boom' })
    expect(sections.env).toMatchObject({ nuxt: nuxtVersion, vue: vueVersion })
  })

  it('renders error.vue with the overlay injected', async () => {
    const response = await fetch(`${url}/boom`, { headers: { accept: 'text/html' } })
    const html = await response.text()
    expect(response.status).toBe(500)
    expect(html).toContain('fixture error page')
    expect(html).toContain('<my-bad-overlay></my-bad-overlay>')

    const state = /<script type="application\/json">(.+?)<\/script>\s*<script>/s.exec(html)![1]!
    const parsed = JSON.parse(state) as { mode: string, startMinimized?: boolean, report: ErrorReport }
    expect(parsed.mode).toBe('overlay')
    expect(parsed.startMinimized).toBe(false)
    expect(frame(parsed.report, 'pages/boom.vue')!.file).toBe(`${root}pages/boom.vue`)
  })

  it('reports server route errors with mapped nitro frames', async () => {
    const { status, report: result } = await report('/api/boom')
    expect(status).toBe(500)
    expect(result.message).toBe('boom from server route')
    log(`[nuxt v${cell.version} nitroViteEnvironment=${cell.nitroViteEnvironment}] /api/boom sourcemaps: ${JSON.stringify(sourcemapUsage(result))}\nraw stack:\n${result.rawStack}`)
    const handler = result.frames[0]!
    const source = (await readFile(`${root}server/api/boom.ts`, 'utf8')).split('\n')
    expect(handler.file).toBe(`${root}server/api/boom.ts`)
    expect(handler.line).toBe(source.findIndex(line => line.includes('boom from server route')) + 1)
  })

  it('propagates status and data from createError', async () => {
    const { status, report: result } = await report('/api/http')
    expect(status).toBe(418)
    expect(result.status).toBe(418)
    expect(result.message).toBe('I am a teapot')
    const data = result.sections.find(section => section.id === 'data')!
    expect(data.content).toMatchObject({ teapot: true })
  })

  it('reports sfc compile errors as compile reports', async () => {
    await writeFile(brokenPage, '<template>\n  <div>{{ oops </div>\n</template>\n')
    const result = await waitFor(async () => {
      const { report: candidate } = await report('/broken')
      return candidate.kind === 'compile' ? candidate : undefined
    }, 30_000, 'a compile report for pages/broken.vue')
    expect(result.message).toContain('Interpolation end sign was not found')
    expect(result.frames[0]).toMatchObject({ file: brokenPage, line: 2, type: 'app' })
    expect(result.frames[0]!.snippet!.lines[1]).toContain('{{ oops')
  })

  it('renders the report in a shadow root and minimises to reveal error.vue', async () => {
    const { chromium } = await import('playwright')
    if (!existsSync(chromium.executablePath())) {
      throw new Error(`chromium is not installed: run \`pnpm playwright install chromium\``)
    }
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(`${url}/boom`, { waitUntil: 'load' })
      const overlay = page.locator('my-bad-overlay')
      const chrome = overlay.locator('[data-overlay]')
      await expect.poll(() => overlay.locator('[data-message]').first().textContent()).toBe('boom from boom page')
      await expect.poll(() => overlay.locator('[data-loc]').first().textContent()).toContain('composables/useBoom.ts:2:9')
      expect(await chrome.evaluate(node => node.hasAttribute('data-minimized'))).toBe(false)

      await overlay.locator('[data-preview] [data-action="minimize"]').click()
      await expect.poll(() => chrome.evaluate(node => node.hasAttribute('data-minimized'))).toBe(true)
      await expect.poll(() => page.getByText('fixture error page').isVisible()).toBe(true)
    }
    finally {
      await browser.close()
    }
  })
})

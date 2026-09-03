import type { ErrorReport, RawSourceMap, ReportPlugin, SourceLoader } from 'my-bad'
import { resolve } from 'node:path'
import process from 'node:process'
import { createReport, fsLoader, injectOverlay, parseInlineSourceMap, renderPage, sourceMapLoader } from 'my-bad'
import { nuxtPreset } from 'my-bad/presets'
import { runtime } from '#fixture/runtime'

const versions = { nuxt: process.env.MY_BAD_NUXT_VERSION ?? 'unknown', vue: process.env.MY_BAD_VUE_VERSION ?? 'unknown' }

interface ViteErrorLike {
  code?: string
  message?: string
  hint?: string
}

/**
 * Nuxt turns a Vite transform failure into a plain `Error` whose message is
 * `<vite module id> <em dash> <reason>` and whose `hint` is the code frame, so
 * the structured `loc`/`plugin`/`id` payload has to be reconstructed here.
 */
function compileInput(error: unknown, cwd: string): { message: string, id?: string, frame?: string, plugin: string } | undefined {
  const vite = [error, (error as { cause?: unknown }).cause].find(candidate => (candidate as ViteErrorLike | undefined)?.code === 'VITE_ERROR') as ViteErrorLike | undefined
  if (!vite) {
    return
  }
  const [id, reason] = (vite.message ?? '').split(/\s+\u2014\s+/)
  return {
    message: reason ?? vite.message ?? 'Transform failed',
    ...(id?.startsWith('/') && { id: resolve(cwd, `.${id}`) }),
    ...(vite.hint && { frame: vite.hint }),
    plugin: 'vite',
  }
}

type SourceMapProvider = 'nitroApp.ssrSourceMaps' | 'vite-node-runner' | '__nitro_vite_envs__'

type SourceMapAccessor = (file: string) => RawSourceMap | undefined

interface ViteEnvironmentRunners {
  [name: string]: {
    runner?: {
      evaluatedModules?: {
        getModuleSourceMapById: (id: string) => { map?: RawSourceMap } | RawSourceMap | null | undefined
      }
    }
  } | undefined
}

/**
 * Sourcemaps for modules evaluated by Nitro's Vite environment runners. Nitro
 * exposes the runners only on `globalThis`, so every use of that global is
 * confined to this function.
 */
function viteEnvironmentSourceMaps(): SourceMapAccessor | undefined {
  const envs = (globalThis as { __nitro_vite_envs__?: ViteEnvironmentRunners }).__nitro_vite_envs__
  if (!envs || !Object.values(envs).some(env => env?.runner?.evaluatedModules)) {
    return
  }
  return (file) => {
    for (const env of Object.values(envs)) {
      const decoded = env?.runner?.evaluatedModules?.getModuleSourceMapById(file)
      const map = decoded && 'map' in decoded ? decoded.map : decoded as RawSourceMap | undefined
      if (map?.mappings) {
        return map
      }
    }
  }
}

interface ViteNodeModuleCache {
  getSourceMap: (id: string) => unknown
  get?: (id: string) => { code?: string } | undefined
}

/** The vite-node runner's module cache, absent once Nitro runs as a Vite environment. */
async function viteNodeSourceMaps(): Promise<SourceMapAccessor | undefined> {
  const runner = await import('#internal/nuxt/vite-node-runner.mjs')
    .then(module => module.default as { moduleCache?: ViteNodeModuleCache })
    .catch(() => undefined)
  const cache = runner?.moduleCache
  if (typeof cache?.getSourceMap !== 'function') {
    return
  }
  return (file) => {
    const map = cache.getSourceMap(file) as RawSourceMap | null | undefined
    if (map?.mappings) {
      return map
    }
    // Nuxt 5's runner caches the transformed code but leaves the entry's parsed
    // map unset, so the inline map has to be read back out of the code.
    const code = cache.get?.(file)?.code
    return typeof code === 'string' ? parseInlineSourceMap(code) : undefined
  }
}

interface SourceMapUsage {
  available: SourceMapProvider[]
  used: SourceMapProvider[]
}

/**
 * Nuxt's SSR modules are evaluated inside the Nitro process, so their maps only
 * exist in memory. Which accessor holds them depends on the dev pipeline, so
 * all of them are tried and the ones that answered are recorded on the report.
 */
function createSourceMapLoaders(): { loaders: SourceLoader[], usage: SourceMapUsage } {
  const usage: SourceMapUsage = { available: [], used: [] }
  const record = (provider: SourceMapProvider, list: SourceMapProvider[]) => {
    if (!list.includes(provider)) {
      list.push(provider)
    }
  }

  return {
    usage,
    loaders: [
      sourceMapLoader({
        async getCode(file) {
          const runner = await import('#internal/nuxt/vite-node-runner.mjs')
            .then(module => module.default as { moduleCache?: ViteNodeModuleCache })
            .catch(() => undefined)
          const fromViteNode = runner?.moduleCache?.get?.(file)?.code
          if (typeof fromViteNode === 'string') {
            return fromViteNode
          }
          const envs = (globalThis as { __nitro_vite_envs__?: Record<string, { runner?: { evaluatedModules?: { getModuleById?: (id: string) => { meta?: { code?: string } } | undefined } } }> }).__nitro_vite_envs__
          for (const env of Object.values(envs ?? {})) {
            const code = env?.runner?.evaluatedModules?.getModuleById?.(file)?.meta?.code
            if (typeof code === 'string') {
              return code
            }
          }
        },
        async getSourceMap(file) {
          const providers: [SourceMapProvider, SourceMapAccessor | undefined][] = [
            ['nitroApp.ssrSourceMaps', runtime.ssrSourceMaps()],
            ['vite-node-runner', await viteNodeSourceMaps()],
            ['__nitro_vite_envs__', viteEnvironmentSourceMaps()],
          ]
          let map: RawSourceMap | undefined
          for (const [provider, accessor] of providers) {
            if (!accessor) {
              continue
            }
            record(provider, usage.available)
            let candidate: RawSourceMap | undefined
            try {
              candidate = accessor(file)
            }
            catch {
              candidate = undefined
            }
            if (candidate?.mappings && !map) {
              record(provider, usage.used)
              map = candidate
            }
          }
          return map
        },
      }),
      fsLoader(),
    ],
  }
}

function sourceMapUsagePlugin(usage: SourceMapUsage): ReportPlugin {
  return {
    name: 'fixture:sourcemaps',
    transform(report) {
      report.sections.push({
        id: 'sourcemaps',
        title: 'Sourcemaps',
        content: {
          available: usage.available.join(', ') || 'none',
          used: usage.used.join(', ') || 'none',
          nitroViteEnvironment: process.env.MY_BAD_NITRO_VITE_ENVIRONMENT === 'true',
        },
      })
    },
  }
}

interface DefaultHandlerResult {
  status?: number
  statusText?: string
  headers: Record<string, string>
  body: unknown
}

type DefaultHandler = (error: unknown, event: unknown, options: { json: true }) => Promise<DefaultHandlerResult>

export default async function handler(error: unknown, event: unknown, { defaultHandler }: { defaultHandler: DefaultHandler }): Promise<unknown> {
  if (runtime.isHandled(event)) {
    return
  }

  const status = (error as { status?: number, statusCode?: number }).status || (error as { statusCode?: number }).statusCode || 500
  const reqHeaders = runtime.requestHeaders(event)
  const context = (event as { context?: Record<string, unknown> }).context
  const captured = context?.myBad as { instance?: unknown, rawStack?: string } | undefined

  // Nuxt's `fix-stacktrace` Nitro plugin rewrites `error.stack` in place from a
  // fire-and-forget `error` hook, so by the time we get here the stack may or
  // may not have been mapped already. Restore the stack captured in `vue:error`
  // so mapping is applied exactly once.
  if (captured?.rawStack) {
    (error as Error).stack = captured.rawStack
  }

  const cwd = process.cwd()
  const compile = compileInput(error, cwd)
  const { loaders, usage } = createSourceMapLoaders()
  const plugins = [sourceMapUsagePlugin(usage)]
  const report: ErrorReport = compile
    ? await createReport(compile, { cwd, kind: 'compile', presets: [nuxtPreset({ versions })], plugins, context: { event }, loaders })
    : await createReport(error, { cwd, presets: [nuxtPreset({ versions })], plugins, context: { event, instance: captured?.instance }, loaders })

  const accept = String(reqHeaders.accept || '')
  if (accept.includes('application/json') || !accept.includes('text/html')) {
    return runtime.respond(event, { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) })
  }

  const defaultRes = await defaultHandler(error, event, { json: true })
  const errorObject = defaultRes.body as Record<string, unknown>
  // Behind the dev proxy the request URL can arrive absolute; the error page
  // routes on it, so it must be a path.
  if (typeof errorObject.url === 'string' && /^https?:\/\//.test(errorObject.url)) {
    const parsed = new URL(errorObject.url)
    errorObject.url = `${parsed.pathname}${parsed.search}`
  }
  delete defaultRes.headers['content-type']
  delete defaultRes.headers['content-security-policy']

  const page = runtime.path(event).startsWith('/__nuxt_error') || reqHeaders['x-nuxt-error']
    ? null
    : await runtime.fetchErrorPage(event, errorObject, { ...reqHeaders, 'x-nuxt-error': 'true' })

  if (runtime.isHandled(event)) {
    return
  }

  const headers = { ...defaultRes.headers, 'content-type': 'text/html;charset=UTF-8' }

  if (!page) {
    return runtime.respond(event, { status, headers, body: renderPage(report, { cwd }) })
  }

  return runtime.respond(event, {
    status: page.status && page.status !== 200 ? page.status : status,
    statusText: page.statusText,
    headers,
    body: injectOverlay(page.html, report, { cwd, startMinimized: status < 500 }),
  })
}

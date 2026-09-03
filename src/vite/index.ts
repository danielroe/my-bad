import type { HotChannel, Plugin, ViteDevServer } from 'vite'
import type { Channel, ChannelOptions } from '../channel'
import type { RenderOverlayOptions, RenderPageOptions } from '../render/html'
import type { ErrorReport, ReportOptions, ReportPreset, SourceLoader } from '../types'
import { fileURLToPath } from 'node:url'
import { createChannel } from '../channel'
import { fsLoader } from '../loaders/fs'
import { renderOverlay, renderPage } from '../render/html'
import { createReport } from '../report/create'
import { viteLoader } from './loader'

export { viteLoader } from './loader'
export type { ViteLoaderOptions } from './loader'

export interface MyBadViteOptions {
  /** Mount the live channel and inject the overlay client. Default `true`. */
  channel?: boolean | ChannelOptions
  /** Base path for the channel middleware. Default `/__my-bad`. */
  base?: string
  presets?: ReportPreset[]
  report?: Omit<ReportOptions, 'loaders' | 'presets'>
  overlay?: Omit<RenderOverlayOptions, 'channel' | 'cwd'>
  /** Replace Vite's built-in error overlay for compile errors. Default `true`. */
  replaceOverlay?: boolean
}

export interface MyBadContext {
  channel: Channel
  base: string
  loaders: SourceLoader[]
  /** Build a report using the Vite module graph for sourcemaps. */
  report: (error: unknown, options?: ReportOptions) => Promise<ErrorReport>
  /** Render a full error page wired to the channel. */
  page: (report: ErrorReport, options?: RenderPageOptions) => string
  /** Render an overlay wired to the channel. */
  overlay: (report: ErrorReport, options?: RenderOverlayOptions) => string
  /** Report an error: stores it, notifies connected pages and in-app clients. */
  emit: (error: unknown, options?: ReportOptions) => Promise<ErrorReport>
  clear: (id?: string) => void
}

const contexts = new WeakMap<object, MyBadContext>()

/** Access the my-bad context for a dev server once the plugin has configured it. */
export function useMyBad(server: ViteDevServer): MyBadContext | undefined {
  return contexts.get(server.config)
}

const CLIENT_ID = 'virtual:my-bad/client'
const RESOLVED_CLIENT_ID = `\0${CLIENT_ID}`
/** Browser URL for the virtual module, following Vite's `\0` encoding. */
const CLIENT_URL = `/@id/__x00__${CLIENT_ID}`

/** Import the client that ships next to this module by absolute path, so the project never resolves `my-bad` itself. */
function clientSource(): string {
  const file = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './client.ts' : './client.mjs', import.meta.url))
  return `import { installMyBadClient } from ${JSON.stringify(`/@fs/${file.replace(/^\//, '')}`)}\ninstallMyBadClient(import.meta.hot)\n`
}

export function myBad(options: MyBadViteOptions = {}): Plugin {
  const base = (options.base ?? '/__my-bad').replace(/\/$/, '')
  const live = options.channel !== false
  let server: ViteDevServer | undefined
  let ctx: MyBadContext | undefined

  return {
    name: 'my-bad',
    apply: 'serve',

    config() {
      if (live && options.replaceOverlay !== false) {
        return { server: { hmr: { overlay: false } } }
      }
    },

    configureServer(devServer) {
      server = devServer
      const channel = createChannel(typeof options.channel === 'object' ? options.channel : { open: true })
      const cwd = options.report?.cwd ?? devServer.config.root
      const loaders = [viteLoader(devServer), fsLoader()]
      const presets = options.presets ?? []

      const hots = (): HotChannel[] => {
        const environments = (devServer as unknown as { environments?: Record<string, { hot: HotChannel }> }).environments
        return environments ? Object.values(environments).map(env => env.hot) : [devServer.ws as unknown as HotChannel]
      }

      /** An error raised while the page loads predates the HMR socket, so replay the latest overlay to each new client. */
      let pending: { type: 'custom', event: string, data: unknown } | undefined
      const broadcast = (payload: { type: 'custom', event: string, data: unknown }) => {
        for (const hot of hots()) {
          hot.send?.(payload)
        }
      }
      for (const hot of hots()) {
        hot.on?.('connection', () => {
          if (pending) {
            hot.send?.(pending)
          }
        })
      }

      ctx = {
        channel,
        base,
        loaders,
        report: (error, reportOptions) => createReport(error, { cwd, loaders, presets, ...options.report, ...reportOptions }),
        page: (report, pageOptions) => renderPage(report, { cwd, channel: live ? base : undefined, history: channel.history, ...pageOptions }),
        overlay: (report, overlayOptions) => renderOverlay(report, { cwd, channel: live ? base : undefined, history: channel.history, ...options.overlay, ...overlayOptions }),
        async emit(error, reportOptions) {
          const report = await ctx!.report(error, reportOptions)
          channel.setError(report)
          if (live) {
            pending = { type: 'custom', event: 'my-bad:error', data: { id: report.id, html: ctx!.overlay(report) } }
            broadcast(pending)
          }
          return report
        },
        clear(id) {
          channel.clearError(id)
          pending = undefined
          if (live) {
            broadcast({ type: 'custom', event: 'my-bad:clear', data: { id } })
          }
        },
      }
      contexts.set(devServer.config, ctx)

      if (!live) {
        return
      }

      devServer.middlewares.use(base, (req, res, next) => {
        req.url = `${base}${req.url ?? ''}`
        channel.handler(req, res).then(handled => handled || next()).catch(next)
      })

      let erroredIds = new Set<string>()
      for (const hot of hots()) {
        if (!hot.send) {
          continue
        }
        const send = hot.send.bind(hot)
        hot.send = ((payload: unknown, ...rest: unknown[]) => {
          const message = payload as { type?: string, err?: { id?: string }, updates?: Array<{ path?: string }> }
          if (message?.type === 'error' && message.err) {
            if (message.err.id) {
              erroredIds.add(message.err.id)
            }
            void ctx!.emit(message.err, { kind: 'compile' })
          }
          else if ((message?.type === 'update' || message?.type === 'full-reload') && channel.current) {
            erroredIds = new Set()
            ctx!.clear()
          }
          return (send as (...args: unknown[]) => unknown)(payload, ...rest)
        }) as typeof hot.send
      }
    },

    resolveId(id) {
      if (id === CLIENT_ID) {
        return RESOLVED_CLIENT_ID
      }
    },

    async load(id) {
      if (id === RESOLVED_CLIENT_ID) {
        return clientSource()
      }
    },

    transformIndexHtml() {
      if (!live || !server) {
        return
      }
      return [{ tag: 'script', attrs: { type: 'module', src: CLIENT_URL }, injectTo: 'head' }]
    },
  }
}

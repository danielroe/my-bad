import type { ReportPreset, TraceEntry } from '../types'
import { toPath } from '../report/path'

interface VueLikeInstance {
  type?: { __name?: string, name?: string, __file?: string }
  parent?: VueLikeInstance | null
  /** Internal instance, present when given a public instance proxy. */
  $?: VueLikeInstance
}

const TRACE_LINE_RE = /^\s*at\s+<([^\s>]+)(?:\s[^>]*)?>\s*$/

/** Parse the `trace` string Vue passes to `app.config.warnHandler`. */
export function parseVueTrace(trace: string): TraceEntry[] {
  const entries: TraceEntry[] = []
  for (const line of trace.split('\n')) {
    const name = TRACE_LINE_RE.exec(line)?.[1]
    if (name) {
      entries.push({ label: `<${name}>` })
    }
  }
  return entries.reverse()
}

/** Build a component trace from a Vue component instance (`getCurrentInstance()` or the `instance` argument of `errorHandler`). */
export function traceFromInstance(instance: VueLikeInstance | null | undefined): TraceEntry[] {
  const entries: TraceEntry[] = []
  let current = instance?.$ ?? instance
  let guard = 0
  while (current && guard++ < 100) {
    const type = current.type
    const file = type?.__file ? toPath(type.__file) : undefined
    const name = type?.__name ?? type?.name ?? (file ? file.split(/[\\/]/).pop()!.replace(/\.\w+$/, '') : 'Anonymous')
    entries.push({ label: `<${name}>`, ...(file && { file }) })
    current = current.parent
  }
  return entries.reverse()
}

export interface VuePresetOptions {
  /** Patterns marking frames as framework internals in addition to Vue's own. */
  internal?: (string | RegExp)[]
}

/**
 * Vue support: component traces from `context.instance` or `context.trace`,
 * Vue runtime frames marked as internal.
 */
export function vuePreset(options: VuePresetOptions = {}): ReportPreset {
  return {
    internal: [/\/node_modules\/(?:@vue|vue)\//, /\/@vue\/(?:runtime|reactivity|shared|server-renderer|compiler)/, ...(options.internal ?? [])],
    plugins: [{
      name: 'vue',
      transform(report, ctx) {
        if (report.trace?.length) {
          return
        }
        const { instance, trace } = ctx.options.context as { instance?: VueLikeInstance, trace?: string }
        const inputTrace = (ctx.input as { vueTrace?: string } | undefined)?.vueTrace
        if (instance) {
          report.trace = traceFromInstance(instance)
        }
        else if (typeof trace === 'string' || typeof inputTrace === 'string') {
          report.trace = parseVueTrace((trace ?? inputTrace)!)
        }
        if (report.trace && !report.trace.length) {
          delete report.trace
        }
      },
    }],
  }
}

import type { Sink } from '../channel'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from '../report/path'

export interface FileSinkOptions {
  /** Event types to record. Default: everything except `build`. */
  types?: string[]
}

/**
 * Append channel events as JSON lines to a file, e.g. `.nuxt/my-bad.jsonl`,
 * so agents and other tools can tail the dev server's errors.
 */
export function fileSink(path: string, options: FileSinkOptions = {}): Sink {
  const types = options.types ? new Set(options.types) : undefined
  let queue: Promise<unknown> | undefined
  return (event) => {
    if (types ? !types.has(event.type) : event.type === 'build') {
      return
    }
    const line = `${JSON.stringify({ timestamp: Date.now(), ...event })}\n`
    queue ??= mkdir(dirname(path), { recursive: true }).catch(() => {})
    queue = queue.then(() => appendFile(path, line)).catch(() => {})
    return queue as Promise<void>
  }
}

/** Fan out to several sinks. */
export function combineSinks(...sinks: Sink[]): Sink {
  return async (event) => {
    await Promise.all(sinks.map(sink => Promise.resolve(sink(event)).catch(() => {})))
  }
}

import type { ReportPreset } from '../types'
import process from 'node:process'
import { version } from '../../package.json'

declare const Bun: unknown
declare const Deno: unknown

export interface EnvPresetOptions {
  /** Extra versions to include, e.g. `{ nuxt: '4.0.0' }`. */
  versions?: Record<string, string | undefined>
}

/** Adds a collapsed `Environment` section with runtime and package versions. */
export function envPreset(options: EnvPresetOptions = {}): ReportPreset {
  return {
    plugins: [{
      name: 'env',
      transform(report) {
        if (report.sections.some(section => section.id === 'env')) {
          return
        }
        const runtime = typeof Bun !== 'undefined' ? `bun ${(Bun as { version: string }).version}` : typeof Deno !== 'undefined' ? `deno ${(Deno as { version: { deno: string } }).version.deno}` : `node ${process.versions?.node ?? 'unknown'}`
        const content: Record<string, string> = { 'runtime': runtime, 'my-bad': version }
        for (const [name, value] of Object.entries(options.versions ?? {})) {
          if (value) {
            content[name] = value
          }
        }
        report.sections.push({ id: 'env', title: 'Environment', content, collapsed: true })
      },
    }],
  }
}

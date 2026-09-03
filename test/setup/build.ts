import { execFile } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Fixtures whose dev servers bundle the app themselves (Nitro, Nuxt) import
 * `my-bad` from `dist`, since their pipelines lack the `virtual:my-bad-client`
 * build plugin. Build once before any test file runs so they never race.
 */
export default async function setup(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
  await promisify(execFile)(process.execPath, [`${repoRoot}node_modules/tsdown/dist/run.mjs`], { cwd: repoRoot })
}

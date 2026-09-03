import { fileURLToPath } from 'node:url'
import { defineNitroConfig } from 'nitro/config'

const dist = fileURLToPath(new URL('../../../dist/', import.meta.url))

export default defineNitroConfig({
  compatibilityDate: '2026-01-01',
  serverDir: '.',
  errorHandler: './error',
  runtimeConfig: { cwd: import.meta.dirname },
  alias: {
    'my-bad/channel': `${dist}channel/index.mjs`,
    'my-bad/presets': `${dist}presets/index.mjs`,
    'my-bad': `${dist}index.mjs`,
  },
})

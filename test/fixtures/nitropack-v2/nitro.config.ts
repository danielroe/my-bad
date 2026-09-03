import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineNitroConfig } from 'nitropack/config'

const dist = new URL('../../../dist/', import.meta.url)

export default defineNitroConfig({
  compatibilityDate: '2025-01-01',
  alias: {
    'my-bad/presets': fileURLToPath(new URL('presets/index.mjs', dist)),
    'my-bad': fileURLToPath(new URL('index.mjs', dist)),
  },
  errorHandler: process.env.MY_BAD_DEFAULT_HANDLER ? undefined : fileURLToPath(new URL('./error.ts', import.meta.url)),
})

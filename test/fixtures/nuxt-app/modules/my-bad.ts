import { fileURLToPath } from 'node:url'
import { defineNuxtModule, getNuxtVersion } from 'nuxt/kit'

const fixtureDir = fileURLToPath(new URL('../', import.meta.url))
const distDir = fileURLToPath(new URL('../../../../dist/', import.meta.url))

export default defineNuxtModule({
  meta: { name: 'fixture-my-bad' },
  setup(_options, nuxt) {
    const major = Number.parseInt(getNuxtVersion(nuxt), 10)
    nuxt.hook('nitro:config', (nitroConfig) => {
      nitroConfig.errorHandler = `${fixtureDir}error-handler.ts`
      nitroConfig.alias = {
        ...nitroConfig.alias,
        '#fixture/runtime': `${fixtureDir}runtime/nuxt-v${major >= 5 ? 5 : 4}.ts`,
        'my-bad/presets': `${distDir}presets/index.mjs`,
        'my-bad': `${distDir}index.mjs`,
      }
    })
  },
})

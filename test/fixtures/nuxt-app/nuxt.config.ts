import process from 'node:process'

export default defineNuxtConfig({
  modules: ['./modules/my-bad'],
  telemetry: false,
  ssr: true,
  devtools: { enabled: false },
  experimental: {
    appManifest: false,
    nitroViteEnvironment: process.env.MY_BAD_NITRO_VITE_ENVIRONMENT === 'true',
  },
  nitro: {
    errorHandler: './error-handler',
  },
})

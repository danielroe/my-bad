import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { clientPlugin } from './scripts/client-plugin.ts'

export default defineConfig({
  plugins: [clientPlugin()],
  resolve: {
    alias: {
      'my-bad': fileURLToPath(new URL('./src/index.ts', import.meta.url).href),
    },
  },
  test: {
    globalSetup: ['./test/setup/build.ts'],
    coverage: {
      include: ['src'],
      reporter: ['text', 'json', 'html'],
    },
  },
})

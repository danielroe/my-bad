import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import pkg from './package.json' with { type: 'json' }
import { clientPlugin } from './scripts/client-plugin.ts'

export default defineConfig({
  define: { __MY_BAD_VERSION__: JSON.stringify(pkg.version) },
  plugins: [clientPlugin()],
  resolve: {
    alias: {
      'my-bad': fileURLToPath(new URL('./src/index.ts', import.meta.url).href),
    },
  },
  test: {
    exclude: ['**/node_modules/**', 'test/visual/**'],
    globalSetup: ['./test/setup/build.ts'],
    coverage: {
      include: ['src'],
      reporter: ['text', 'json', 'html'],
    },
  },
})

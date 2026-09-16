import { defineConfig } from 'tsdown'
import pkg from './package.json' with { type: 'json' }
import { clientPlugin } from './scripts/client-plugin.ts'

export default defineConfig({
  entry: ['src/index.ts', 'src/channel/index.ts', 'src/vite/index.ts', 'src/vite/client.ts', 'src/presets/index.ts', 'src/sinks/index.ts'],
  dts: { generator: 'oxc' },
  exports: {
    devExports: true,
    customExports(exports) {
      delete exports['./client.js']
      delete exports['./client.css']
      return exports
    },
  },
  deps: { neverBundle: ['tiny-open'] },
  define: { __MY_BAD_VERSION__: JSON.stringify(pkg.version) },
  plugins: [clientPlugin({ emit: true })],
})

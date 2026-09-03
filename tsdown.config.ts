import { defineConfig } from 'tsdown'
import { clientPlugin } from './scripts/client-plugin.ts'

export default defineConfig({
  entry: ['src/index.ts', 'src/channel/index.ts', 'src/vite/index.ts', 'src/vite/client.ts', 'src/presets/index.ts', 'src/sinks/index.ts'],
  dts: { oxc: true },
  exports: { devExports: true },
  deps: { neverBundle: ['tiny-open'] },
  plugins: [clientPlugin()],
})

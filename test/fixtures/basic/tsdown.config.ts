import { defineConfig } from 'tsdown'

export default defineConfig([
  { entry: ['src/thrower.ts'], outDir: 'dist/sidecar', sourcemap: true, dts: false, clean: true, format: 'esm' },
  { entry: ['src/thrower.ts'], outDir: 'dist/inline', sourcemap: 'inline', dts: false, clean: true, format: 'esm' },
])

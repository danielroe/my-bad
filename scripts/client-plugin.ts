import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'
import { build } from 'vite'

const root = fileURLToPath(new URL('../src/render/html/', import.meta.url))

const VIRTUAL_ID = 'virtual:my-bad-client'
const BADGE_STYLES_ID = 'virtual:my-bad-badge-styles'

export interface ClientPluginOptions {
  /**
   * Write the client bundles and stylesheet as `client.js` / `client.css` /
   * `badge.js` next to the output and read them on first use, instead of
   * embedding them as string literals that every importer must parse.
   * Default `false`.
   */
  emit?: boolean
}

/**
 * Bundles `src/render/html/client/main.ts` and `client/badge.ts` into
 * self-contained IIFEs and exposes them (and the stylesheet) through
 * `getClientScript` / `getClientStyles` / `getBadgeScript` exports of
 * `virtual:my-bad-client`.
 */
export function clientPlugin(options: ClientPluginOptions = {}) {
  return {
    name: 'my-bad:client',
    resolveId(id: string) {
      return id === VIRTUAL_ID ? `\0${VIRTUAL_ID}` : undefined
    },
    async load(this: { emitFile: (file: { type: 'asset', fileName: string, source: string }) => unknown }, id: string) {
      if (id !== `\0${VIRTUAL_ID}`) {
        return
      }
      const [script, styles, badge] = await Promise.all([
        bundleClient('main.ts'),
        bundleStyles('styles.css'),
        bundleStyles('badge.css').then(css => bundleClient('badge.ts', css)),
      ])
      const assets = { getClientScript: ['client.js', script], getClientStyles: ['client.css', styles], getBadgeScript: ['badge.js', badge] }
      if (!options.emit) {
        return Object.entries(assets).map(([name, [, source]]) => `export const ${name} = () => ${JSON.stringify(source)}\n`).join('')
      }
      const lines = [`import { readFileSync } from 'node:fs'`]
      for (const [name, [fileName, source]] of Object.entries(assets)) {
        this.emitFile({ type: 'asset', fileName: fileName!, source: source! })
        lines.push(`let ${name}Cache`, `export const ${name} = () => ${name}Cache ??= readFileSync(new URL('./${fileName}', import.meta.url), 'utf8')`)
      }
      return `${lines.join('\n')}\n`
    },
  }
}

/** Minify a stylesheet, since it is inlined into pages and scripts. */
async function bundleStyles(file: string): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    css: { postcss: {} },
    build: {
      write: false,
      cssMinify: true,
      // A modern target rewrites `max-width` to media range syntax, which is
      // newer than the rest of the stylesheet needs and puts a bare `<` in the
      // inlined `<style>` block.
      target: 'safari15',
      rollupOptions: { input: `${root}${file}` },
    },
  })
  const outputs = Array.isArray(result) ? result.flatMap(chunk => chunk.output) : 'output' in result ? result.output : []
  const css = outputs.find(output => output.fileName.endsWith('.css'))
  if (!css || css.type !== 'asset' || typeof css.source !== 'string') {
    throw new Error(`Failed to minify ${file}`)
  }
  return css.source
}

/** `styles` is the default export of `virtual:my-bad-badge-styles` inside the bundle. */
async function bundleClient(entry: string, styles = ''): Promise<string> {
  const bundle = await rolldown({
    input: `${root}client/${entry}`,
    platform: 'browser',
    logLevel: 'silent',
    plugins: [{
      name: 'my-bad:badge-styles',
      resolveId: id => id === BADGE_STYLES_ID ? `\0${BADGE_STYLES_ID}` : undefined,
      load: id => id === `\0${BADGE_STYLES_ID}` ? `export default ${JSON.stringify(styles)}` : undefined,
    }],
  })
  try {
    const { output } = await bundle.generate({ format: 'iife', minify: true, sourcemap: false })
    const code = output[0]!.code.replace(/\$(?=[&'`<\d])/g, '$ ')
    const unsafe = /\$[&'`<\d]/.exec(code)
    if (unsafe) {
      throw new Error(`Client bundle contains "${unsafe[0]}", which String.prototype.replace would interpret in a replacement string`)
    }
    return code
  }
  finally {
    await bundle.close()
  }
}

import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'
import { build } from 'vite'

const root = fileURLToPath(new URL('../src/render/html/', import.meta.url))

const VIRTUAL_ID = 'virtual:my-bad-client'

export interface ClientPluginOptions {
  /**
   * Write the client bundle and stylesheet as `client.js` / `client.css` next to
   * the output and read them on first use, instead of embedding them as string
   * literals that every importer must parse. Default `false`.
   */
  emit?: boolean
}

/**
 * Bundles `src/render/html/client/main.ts` into a self-contained IIFE and exposes
 * it (and the stylesheet) through `getClientScript` / `getClientStyles` exports
 * of `virtual:my-bad-client`.
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
      const [script, styles] = await Promise.all([bundleClient(), bundleStyles()])
      if (!options.emit) {
        return `export const getClientScript = () => ${JSON.stringify(script)}\nexport const getClientStyles = () => ${JSON.stringify(styles)}\n`
      }
      this.emitFile({ type: 'asset', fileName: 'client.js', source: script })
      this.emitFile({ type: 'asset', fileName: 'client.css', source: styles })
      return [
        `import { readFileSync } from 'node:fs'`,
        `let script, styles`,
        `export const getClientScript = () => script ??= readFileSync(new URL('./client.js', import.meta.url), 'utf8')`,
        `export const getClientStyles = () => styles ??= readFileSync(new URL('./client.css', import.meta.url), 'utf8')`,
        '',
      ].join('\n')
    },
  }
}

/** Minify the stylesheet, which is inlined into every rendered page. */
async function bundleStyles(): Promise<string> {
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
      rollupOptions: { input: `${root}styles.css` },
    },
  })
  const outputs = Array.isArray(result) ? result.flatMap(chunk => chunk.output) : 'output' in result ? result.output : []
  const css = outputs.find(output => output.fileName.endsWith('.css'))
  if (!css || css.type !== 'asset' || typeof css.source !== 'string') {
    throw new Error('Failed to minify styles.css')
  }
  return css.source
}

async function bundleClient(): Promise<string> {
  const bundle = await rolldown({
    input: `${root}client/main.ts`,
    platform: 'browser',
    logLevel: 'silent',
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

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = fileURLToPath(new URL('../src/render/html/', import.meta.url))

const VIRTUAL_ID = 'virtual:my-bad-client'

/**
 * Bundles `src/render/html/client/main.ts` into a self-contained IIFE and exposes
 * it (and the stylesheet) as string exports of `virtual:my-bad-client`, so the
 * renderers can inline them without reading from disk at runtime.
 */
export function clientPlugin() {
  return {
    name: 'my-bad:client',
    resolveId(id: string) {
      return id === VIRTUAL_ID ? `\0${VIRTUAL_ID}` : undefined
    },
    async load(id: string) {
      if (id !== `\0${VIRTUAL_ID}`) {
        return
      }
      const [script, styles] = await Promise.all([bundleClient(), readFile(`${root}styles.css`, 'utf8')])
      return `export const clientScript = ${JSON.stringify(script)}\nexport const clientStyles = ${JSON.stringify(styles)}\n`
    },
  }
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

import type { Page } from 'playwright/test'
import type { Plugin } from 'vite'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { renderBadge } from '../../dist/index.mjs'
import { myBad, useMyBad } from '../../dist/vite/index.mjs'

const root = fileURLToPath(new URL('./app/', import.meta.url))

const typescript = [
  {
    code: 'TS2741',
    message: 'Property \'tags\' is missing in type \'{ id: number; name: string; }\' but required in type \'Widget\'.',
    loc: { line: 11, column: 3 },
  },
  {
    code: 'TS2367',
    message: 'This comparison appears to be unintentional because the types \'number\' and \'string\' have no overlap.',
    loc: { line: 19, column: 33 },
  },
  {
    code: 'TS2551',
    message: 'Property \'nme\' does not exist on type \'Widget\'. Did you mean \'name\'?',
    loc: { line: 24, column: 20 },
  },
]

const eslint = [
  {
    code: 'ts/consistent-type-definitions',
    message: 'Use a `type` instead of an `interface`.',
    loc: { line: 1, column: 8 },
  },
  {
    code: 'unused-imports/no-unused-vars',
    message: '\'count\' is assigned a value but never used.',
    loc: { line: 23, column: 9 },
  },
]

const badge: Plugin = {
  name: 'showcase-badge',
  transformIndexHtml: html => html.replace('</head>', `${renderBadge({ channel: '/__my-bad', cwd: root })}</head>`),
}

/**
 * Serves `app/` with the Vite plugin and publishes a warning and problem sets
 * from TypeScript and ESLint pointing into `src/widgets.ts`. With Vite
 * DevTools, it also publishes the error `src/render.ts` throws, which the
 * dock lists rather than letting it take over the page.
 */
export async function startShowcase(options: { devtools: boolean }) {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    devtools: options.devtools && { apply: 'serve', clientAuth: false },
    plugins: [
      myBad({ devtools: options.devtools }),
      !options.devtools && badge,
    ],
    server: { port: 0, host: '127.0.0.1' },
  })
  await server.listen()
  const ctx = useMyBad(server)!
  const file = `${root}src/widgets.ts`

  if (options.devtools) {
    const { render } = await server.ssrLoadModule('/src/render.ts')
    try {
      render()
    }
    catch (error) {
      const report = await ctx.report(error)
      report.hint = 'Every widget needs a non-empty name. Check the list passed to loadWidgets().'
      ctx.channel.setError(report)
    }
  }

  ctx.channel.warn(await ctx.report({
    name: 'Deprecation',
    message: 'loadWidgets(names) is deprecated. Pass { names } instead.',
    sources: [`${root}src/render.ts:4:19`],
  }, { kind: 'warning' }))

  ctx.channel.setProblems('typecheck', await Promise.all(typescript.map(problem => ctx.report({
    ...problem,
    name: 'TypeScript',
    loc: { file, ...problem.loc },
  }, { kind: 'error' }))), { label: 'TypeScript', url: '/__typecheck/' })

  ctx.channel.setProblems('lint', await Promise.all(eslint.map(problem => ctx.report({
    ...problem,
    name: 'ESLint',
    loc: { file, ...problem.loc },
  }, { kind: 'warning' }))), { label: 'ESLint', url: '/__lint/' })

  return {
    url: server.resolvedUrls!.local[0]!,
    close: () => server.close(),
  }
}

/** Serves the Phosphor icons Vite DevTools requests from Iconify's API out of the local icon set, so renders do not depend on the network. */
export async function routeIcons(page: Page): Promise<void> {
  const { icons } = JSON.parse(await readFile(fileURLToPath(import.meta.resolve('@iconify-json/ph/icons.json')), 'utf8'))
  await page.route('https://api.iconify.design/**', (route) => {
    const name = new URL(route.request().url()).pathname.match(/^\/ph\/(.+)\.svg$/)?.[1]
    const icon = name && icons[name]
    return icon
      ? route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 256 256">${icon.body}</svg>` })
      : route.abort()
  })
}

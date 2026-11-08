# my-bad

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![Github Actions][github-actions-src]][github-actions-href]
[![Codecov][codecov-src]][codecov-href]

> Beautiful dev-server error pages rendered to HTML, ANSI or JSON and live updated over SSE. ✨

`my-bad` turns an error into a JSON report with sourcemapped frames, source snippets, causes, a component trace, and request context. You can render the report as a full HTML page, as an overlay on an existing page, or as ANSI text for the terminal.

A live channel keeps open pages up to date. Pages swap in new errors and reload once an error is fixed. The channel also carries warnings, logs, and problems from tools such as type checkers and linters.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/page-dark.png">
  <img src="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/page-light.png" alt="An error page showing the error name, message, hint, component trace and a syntax-highlighted source snippet with the failing line marked">
</picture>

The same report in the terminal:

<img src="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/ansi.svg" alt="Terminal output showing the error, a hint, the component trace, source snippets for the error and its cause, and the collapsed stack frames">

## Install

`my-bad` requires Node.js 22.12 or later.

```sh
npm install my-bad
```

## Use it with Vite

Add the plugin to your Vite config:

```ts
import { myBad } from 'my-bad/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    myBad()
  ]
})
```

Compile errors now open in an overlay, with frames mapped through the Vite module graph. The overlay closes when the next update succeeds.

### Add Vite DevTools

If you use [Vite DevTools](https://devtools.vite.dev/guide/), `myBad()` adds a dock to it. You don't need to configure `my-bad`. Install `@vitejs/devtools`, then enable DevTools in the same config:

```ts
import { myBad } from 'my-bad/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  devtools: true,
  plugins: [
    myBad()
  ]
})
```

The dock lists the open error, the warnings, and every problem set. Errors no longer take over the page while DevTools is running.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/devtools-dark.png">
  <img src="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/devtools-light.png" alt="The my-bad dock open in Vite DevTools, listing the open error, a warning, three TypeScript errors and two ESLint warnings, with the error's hint and source snippet shown beside them">
</picture>

## Use it in any dev server

In the error handler of your dev server, build a report and render it. In this example, `error`, `req`, and `res` come from your server:

```ts
import { createReport, renderAnsi, renderPage, serializeReport } from 'my-bad'

const cwd = process.cwd()
const report = await createReport(error, { cwd })

console.error(renderAnsi(report, { cwd }))

res.statusCode = 500
if (req.headers.accept?.includes('text/html')) {
  res.setHeader('content-type', 'text/html')
  res.end(renderPage(report, { cwd }))
}
else {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(serializeReport(report, { cwd })))
}
```

To keep pages live, add the channel and the badge. The [dev server guide](https://github.com/danielroe/my-bad/blob/main/docs/dev-server.md) walks through each step.

## Show problems from other tools

Type checkers, linters, and audits can publish their current diagnostics as a problem set. Every page that renders the badge shows a count for each tool, and opens the problems beside the page:

```ts
import { createProblemReport } from 'my-bad'

channel.setProblems('lint', results.map(result => createProblemReport({
  name: 'ESLint',
  message: result.message,
  code: result.ruleId,
  file: result.file,
  line: result.line,
  column: result.column,
  kind: result.severity === 2
    ? 'error'
    : 'warning',
})), { label: 'ESLint', url: '/__lint/' })
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/drawer-dark.png">
  <img src="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/drawer-light.png" alt="The problems drawer beside a page, listing a warning, three TypeScript errors and two ESLint warnings, with the first TypeScript error and its source snippet shown beside them">
</picture>

## Next steps

- [Integrate with a dev server](https://github.com/danielroe/my-bad/blob/main/docs/dev-server.md): connect reports, the channel, and the badge in your own server.
- [Use with Vite](https://github.com/danielroe/my-bad/blob/main/docs/vite.md): render server errors, and configure the plugin and Vite DevTools.
- [Publish problems](https://github.com/danielroe/my-bad/blob/main/docs/problems.md): show diagnostics from a type checker, linter, or audit.
- [Reference](https://github.com/danielroe/my-bad/blob/main/docs/README.md): reports, rendering, the live channel, and every export.

## 💻 Development

```bash
git clone git@github.com:danielroe/my-bad.git
corepack enable

# run interactive tests
pnpm dev
# run accessibility audit (computed contrast, axe-core, target sizes, focus, motion, reflow)
pnpm test:a11y
# render screenshots of the ui
pnpm screenshot

# re-render the screenshots in assets/ (autofix.ci keeps these current)
pnpm assets
# experiment in the playground
pnpm play
pnpm play:vite
```

## Credits

This was inspired by [youch](https://github.com/poppinss/youch), which is a phenomenal error page generator, and I would highly recommend it!

## License

Made with ❤️

Published under [MIT License](./LICENCE).

<!-- Badges -->

[npm-version-src]: https://npmx.dev/api/registry/badge/version/my-bad
[npm-version-href]: https://npmx.dev/package/my-bad
[npm-downloads-src]: https://npmx.dev/api/registry/badge/downloads/my-bad
[npm-downloads-href]: https://npm.chart.dev/my-bad
[github-actions-src]: https://img.shields.io/github/actions/workflow/status/danielroe/my-bad/ci.yml?branch=main&style=flat-square
[github-actions-href]: https://github.com/danielroe/my-bad/actions?query=workflow%3Aci
[codecov-src]: https://img.shields.io/codecov/c/gh/danielroe/my-bad/main?style=flat-square
[codecov-href]: https://codecov.io/gh/danielroe/my-bad

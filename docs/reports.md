# Reports

`createReport` turns an error into a plain JSON report with sourcemapped frames, snippets, causes, component trace and request context. Every renderer takes the same report.

```ts
import { createReport, fsLoader } from 'my-bad'
import { nuxtPreset } from 'my-bad/presets'

const report = await createReport(error, {
  cwd: process.cwd(),
  loaders: [
    fsLoader()
  ],
  presets: [
    nuxtPreset({
      versions: { nuxt: '4.0.0' }
    })
  ],
  context: { event },
})
```

## Diagnostics

An error that carries its own guidance is read without any configuration. `fix` becomes the report's `hint`, a `docs` (or `docsUrl`) URL becomes `docsUrl`, and `sources` (`file:line:column`, `file:line` or bare `file` strings) become app frames, with snippets where they have a line, or a `Sources` section when they cannot be resolved to a readable file. An error named after its own `code` is treated as self-describing: the heading shows the code once, and presets leave its `docsUrl` alone, including when it has none.

```ts
class Diagnostic extends Error {
  name = 'NUXT_E1001'
  code = 'NUXT_E1001'
  fix = 'Pass a non-empty `name` prop to `<Widget>`.'
  docs = 'https://nuxt.com/docs/4.x/errors/e1001'
  sources = ['pages/index.vue:2:16']
}
```

`environment` labels where the error happened (`'Server'`, `'Client'`, or whatever your integration calls it) next to the error name.

## Sourcemaps

Frames are mapped by loaders, tried in order:

- `fsLoader()` reads `.map` sidecars and inline `sourceMappingURL` comments (Nitro dev builds, tsdown/rollup output). When `loaders` is not set, `createReport` uses `fsLoader({ roots: [cwd] })`, which only reads inside `cwd`. A loader passed explicitly is used as given: `fsLoader()` reads any absolute path, so confine it with `roots` or `canRead` when the frames can come from an untrusted source, such as a browser-submitted stack.
- `sourceMapLoader({ getSourceMap })` takes maps from memory, for module runners (`nitroApp.ssrSourceMaps.getSourceMap` in Nuxt, `runner.moduleCache.getSourceMap` in vite-node).
- `viteLoader(server)` from `my-bad/vite` uses the module graph of a `ViteDevServer`.
- `passthroughLoader()` only reads sources, for processes whose stacks are already mapped.

A frame is only mapped when the map has a segment on that exact generated line, so already-mapped stacks are never mapped twice. Frames are only mapped and read when they name a module (`.js`, `.ts`, `.vue`, `.svelte` and similar) or an id that is not a file path. Locations that may come from error text (a code frame header, a position quoted in a message, or a stack whose message header cannot be found) are only read inside `cwd` or where an `fsLoader` confined with `roots` or `canRead` allows, so a monorepo can widen the boundary by passing its workspace root.

## Compile errors

A plain error whose message ends in a `file:line:column` line, as parsers and loaders throw, becomes a `compile` report at that position when no `kind` is passed, its `stack` has no frame in application code, and the file is a readable module within those bounds. An error without a `stack` stays an `error`, since nothing shows a dependency raised it; pass a compile-shaped input (`{ message, id, loc }`) to locate it.

Compile errors from a bundler often point into the module it transformed while naming the source file (rolldown failing to parse a compiled render function, say). Their position and code frame then move to `frame.compiled`, so the generated code is labelled as such rather than shown as the source of your file.

That is detected by comparing the frame's **caret line**, the one line the frame asserts describes the reported position, against the file on disk at the line number the frame gives it. Indentation is ignored, and a line Vite truncated for width is matched on the part that survived. If it matches, the frame is source; if it does not, the frame is generated. Neighbouring lines are not compared, because a bare `}` or `})` matches almost any file by chance. Nothing changes when the file cannot be read, or the caret line is only punctuation, or there is no caret at all.

A thrower that already knows better can say so, and is believed without any comparison. This is honoured wherever the error sits in the chain, including as a `cause` at any depth, which is how a compile error wrapped in an `HTTPError` gets it right:

```ts
throw Object.assign(error, { compiled: true })
```

The same thing is available as an option for the top-level input, where `compiled: { sourceLoc }` also supplies a position you have mapped back to source yourself, to get a source snippet alongside the generated one:

```ts
await createReport(error, {
  kind: 'compile',
  compiled: {
    sourceLoc: { line: 6, column: 16 }
  }
})
```

A marker on the error wins over the option, and both win over detection in either direction (`false` opts out entirely, and the file is not read).

## Syntax highlighting

Snippets use a small built-in tokenizer. Plug in your own for richer colours in both HTML and ANSI:

```ts
const report = await createReport(error, {
  tokenizer: (line, lang) => myHighlighter(line, lang).map(token => ({ type: 'keyword', text: token.value })),
})
```

## Presets

`my-bad/presets` exports `envPreset`, `vuePreset`, `requestPreset` (alias `h3Preset`), `nitroPreset` and `nuxtPreset`. Presets contribute frame classification, sections (request, headers with redaction, route, environment), component traces and docs links for error codes.

`nuxtPreset` links codes such as `E1001` or `NUXT_E1001` to `https://nuxt.com/docs/errors/e1001`, which redirects to the current version; pass `docsBase` to point elsewhere.

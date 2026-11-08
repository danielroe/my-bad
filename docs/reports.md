# Reports

A report is a plain JSON object that describes an error or a warning. Every renderer takes the same report, and the live channel sends it to pages as it is. This page covers how `createReport` builds a report, and how to change what it reads and maps.

## Create a report

Pass an error, and the directory of the project, to `createReport`:

```ts
import { createReport } from 'my-bad'

const report = await createReport(error, {
  cwd: process.cwd()
})
```

The report holds the error name, message, and code, its stack frames mapped to the original sources, and source snippets. It also holds the causes, the component trace, and sections such as the request.

Each report has an `id`, a hash of its name, message, and the location of its first app frame. The same error thrown twice gets the same id.

## What my-bad reads from an error

`createReport` accepts an `Error`, any object with a `message`, or any other value. It reads these fields:

| Field | Becomes |
| --- | --- |
| `name`, `message` | The report name and message. |
| `stack` | The frames, mapped through the [source loaders](#map-frames-to-original-sources). |
| `cause` | The causes, up to `maxCauses` deep. |
| `errors` | The related errors of an `AggregateError`. |
| `code` | The report code. |
| `fix` | The hint shown below the message. |
| `docs`, `docsUrl` | A link to the documentation. |
| `sources` | App frames from `file:line:column`, `file:line`, or `file` strings. |
| `statusCode`, `status` | The HTTP status. |
| `data` | A **Data** section. |
| `compiled` | See [Compile errors](#compile-errors). |

`createReport` also accepts the error payload of Vite (`{ message, id, loc, frame, plugin }`). Any other value becomes the message of a report named `Error`.

### Describe an error on the error itself

An error can carry its own guidance, so that `my-bad` shows it without any configuration:

```ts
class WidgetNameError extends Error {
  name = 'NUXT_E1001'
  code = 'NUXT_E1001'
  fix = 'Pass a non-empty `name` prop to `<Widget>`.'
  docs = 'https://nuxt.com/docs/4.x/errors/e1001'
  sources = ['pages/index.vue:2:16']
}
```

Each entry of `sources` becomes an app frame, with a snippet when it names a line. An entry that `my-bad` can't read goes into a **Sources** section instead.

An error named after its own `code` describes itself. The heading shows the code once, and presets don't add a documentation link to it.

## Report options

| Option | Default | Description |
| --- | --- | --- |
| `cwd` | `process.cwd()` | Project directory. Paths are shown relative to it, and the default loader reads only inside it. |
| `kind` | Detected | `error`, `warning`, or `compile`. |
| `loaders` | See [below](#map-frames-to-original-sources) | Source loaders, tried in order. |
| `presets` | `[]` | [Presets](#presets) to apply. |
| `plugins` | `[]` | [Plugins](#write-a-preset) that change the report after it's built. |
| `internal` | `[]` | Strings or regular expressions, matched against the file and function of each frame. Matching frames count as internal. |
| `context` | `{}` | Data for presets and plugins, for example the request or a Vue instance. |
| `tokenizer` | Built in | See [Syntax highlighting](#syntax-highlighting). |
| `compiled` | Detected | See [Compile errors](#compile-errors). |
| `snippets` | `true` | Read source snippets. |
| `snippetLines` | `5` | Lines of source read on each side of the error line. |
| `maxSnippets` | `100` | Snippets across the whole report, causes and related errors included. Later frames keep their location without a snippet. |
| `maxSnippetLineLength` | `500` | Characters of each snippet line. Longer lines are cropped around the column. |
| `maxMappedFrames` | `200` | Frames mapped across the whole report. Later frames are classified, but not mapped. |
| `maxCauses` | `10` | Depth of the cause chain. |
| `maxErrors` | `20` | Related errors kept at each level. |
| `maxMessageLength` | `10000` | Characters of each message. |
| `maxRawStackLength` | `50000` | Characters of each raw stack. |
| `maxSectionLength` | `50000` | Characters of the Data section, built from `error.data`. Sections from presets aren't limited. |

## Map frames to original sources

Source loaders map each frame to its original location and read the source for snippets. `createReport` tries them in order.

Without `loaders`, `createReport` uses the loaders of its presets, and then `fsLoader({ roots: [cwd] })`. That loader reads only inside `cwd`. When you pass `loaders`, `createReport` uses them as given, without the loaders of its presets.

| Loader | Use it for |
| --- | --- |
| `fsLoader()` | Code on disk with `.map` files or inline `sourceMappingURL` comments, such as Nitro dev builds or tsdown and Rollup output. |
| `sourceMapLoader({ getSourceMap })` | Maps held in memory by a module runner, such as `nitroApp.ssrSourceMaps.getSourceMap` in Nuxt or `runner.moduleCache.getSourceMap` in vite-node. |
| `viteLoader(server)` | The module graph of a Vite dev server. Import it from `my-bad/vite`. |
| `passthroughLoader()` | Stacks that are already mapped, for example by `node --enable-source-maps`. It only reads sources, at any path. For stacks from untrusted input, use `fsLoader({ roots, sidecar: false, inline: false })`. |

### Confine what loaders read

`fsLoader()` without options reads any absolute path. If frames can come from an untrusted source, such as a stack that a browser submits, confine it:

```ts
import { fsLoader } from 'my-bad'

fsLoader({
  roots: [workspaceRoot]
})
```

`roots` lists the directories the loader may read. Paths are resolved first, so a symlink that leads out of a root is denied. For a finer check, pass `canRead(file)`, which runs after `roots`.

Some locations come from the text of an error, rather than a stack. Examples are a code frame header, or a position quoted in a message. `createReport` reads those only inside `cwd`, or where a confined `fsLoader` allows. In a monorepo, pass the workspace root in `roots` to widen that boundary.

### How frames are mapped

`my-bad` maps a frame only when the map has a segment on that exact line, so a nearby segment doesn't map an original position again. A segment on the same line still maps it. For stacks that are already mapped, use `passthroughLoader()`. `my-bad` maps and reads only frames that name a module or an id that isn't a file path. Modules include `.js`, `.ts`, `.vue`, and `.svelte` files.

### Loader options

`fsLoader` takes these options:

| Option | Default | Description |
| --- | --- | --- |
| `sidecar` | `true` | Read `<file>.map` files. |
| `inline` | `true` | Read `sourceMappingURL` comments. |
| `roots` | Unrestricted | Directories the loader may read, maps included. The `sourcesContent` of a map is shown only for sources that `roots` and `canRead` allow. |
| `canRead` | | A check for each file, after `roots`. It receives an absolute path with forward slashes. |

`sourceMapLoader` takes these options:

| Option | Default | Description |
| --- | --- | --- |
| `getSourceMap(file)` | | Returns the map of a generated file, or nothing when the file is unknown. Required. |
| `getCode(file)` | | Returns the generated code, so the compiled snippet can be shown. |
| `getVersion(file)` | | Returns a token that changes when the map changes. Maps are cached while the token stays the same. Without it, every lookup calls `getSourceMap`. |
| `fs` | `true` | Read sources from disk for snippets, at any absolute path. `roots` of an `fsLoader` later in the list don't confine these reads. Pass `false` if stacks can come from untrusted input. |
| `sourcesContent` | `true` | Use the `sourcesContent` of the map for snippets. Pass a function to decide for each source. |
| `base(file)` | Directory of the file | Directory that relative sources in the map resolve against. |

`viteLoader(server, { fs })` falls back to reading files from disk unless you pass `fs: false`.

## Compile errors

Parsers and loaders often throw an error whose message ends in a `file:line:column` line. `createReport` turns that error into a `compile` report at that position when all of these are true:

- You don't pass a `kind`.
- The stack has no frame in app code.
- The file is a module that `my-bad` can read.

An error without a stack stays an `error`. To place it, pass the Vite error shape: `{ message, id, loc }`.

### Code frames from compiled code

A bundler sometimes reports a position in the code it generated, but names the source file. For example, Rolldown can fail to parse a compiled Vue render function. `my-bad` then moves the position and code frame to `frame.compiled`, so the page labels the generated code as generated.

To detect this, `my-bad` compares the caret line of the code frame with the file on disk. The caret line is the line that the frame marks for the reported position. Indentation doesn't count, and a line that Vite cut short is matched on the part that remains.

- If the lines match, the frame shows the source.
- If they don't match, the frame shows compiled code.
- If the file can't be read, the caret line is only punctuation, or there's no caret, nothing changes.

`my-bad` doesn't compare the neighbouring lines, because a bare `}` or `})` matches almost any file.

### Mark compiled code yourself

When the code frame of an error comes from compiled code, mark the error with `compiled: true`:

```ts
throw Object.assign(error, { compiled: true })
```

`my-bad` honours the marker wherever the error sits in the chain, including as a deeply nested `cause`. For example, a compile error wrapped in an `HTTPError` keeps its marker.

You can also pass `compiled` as an option for a top-level compile error, one with a `loc` or a code `frame`. Add `sourceLoc` when you have mapped the position back to the source, to show a source snippet next to the compiled one:

```ts
await createReport({
  message: 'Unexpected token',
  id: '/project/src/App.vue',
  loc: { line: 42, column: 8 },
  frame: compiledFrame,
}, {
  kind: 'compile',
  compiled: {
    sourceLoc: { line: 6, column: 16 }
  }
})
```

In this example, `compiledFrame` is the code frame that the compiler printed.

A marker on the error wins over the option. Both win over detection. `compiled: false` turns detection off, so `my-bad` doesn't compare the caret line with the file. Without a code frame, `my-bad` still reads the file for the snippet.

## Syntax highlighting

Snippets use a small built-in tokenizer. For richer colours in both HTML and ANSI output, adapt your own highlighter:

```ts
const report = await createReport(error, {
  tokenizer: (line, lang) => highlightLine(line, lang).map(token => ({
    type: toTokenType(token.type),
    text: token.value
  })),
})
```

`highlightLine` stands for your highlighter, and `toTokenType` for a function that maps its token types to the types below. The tokenizer returns tokens for one line, or `undefined` to use the built-in tokenizer for that line. Token types are `keyword`, `string`, `number`, `comment`, `function`, `type`, `tag`, `attribute`, `operator`, `punctuation`, `variable`, and `text`. The report stores the tokens, so every renderer shows the same colours.

## Presets

Presets add frame classification, sections, component traces, and documentation links for a runtime or framework. Import them from `my-bad/presets`:

```ts
import { createReport } from 'my-bad'
import { nuxtPreset } from 'my-bad/presets'

const report = await createReport(error, {
  cwd,
  presets: [
    nuxtPreset({
      versions: { nuxt: '4.0.0' }
    })
  ],
  context: { event },
})
```

| Preset | Adds |
| --- | --- |
| `requestPreset({ redact, headers })` | **Request** and **Headers** sections from `context.event`, `context.request`, or `context.req`. Headers in `redact` show as `[redacted]`. Also exported as `h3Preset`. |
| `nitroPreset(options)` | `requestPreset`, with Nitro and h3 runtime frames marked as internal. |
| `vuePreset({ internal })` | A component trace from `context.instance` or `context.trace`, with Vue runtime frames marked as internal. |
| `envPreset({ versions })` | A collapsed **Environment** section with the runtime, the `my-bad` version, and the versions you pass. |
| `nuxtPreset({ versions, docsBase, redact })` | `vuePreset`, `nitroPreset`, and `envPreset`, a **Route** section from `context.route`, and Nuxt internals marked as internal. |

`requestPreset` reads h3 v1 and v2 events, Fetch API `Request` objects, and Node.js `IncomingMessage` objects.

`nuxtPreset` links codes such as `E1001` or `NUXT_E1001` to `https://nuxt.com/docs/errors/e1001`, which redirects to the current version. Pass `docsBase` to link elsewhere.

### Write a preset

A preset can add loaders, internal patterns, and plugins. A plugin changes the report after `createReport` builds it:

```ts
import type { ReportPreset } from 'my-bad'

export function releasePreset(release: string): ReportPreset {
  return {
    internal: [/\/node_modules\/my-framework\//],
    plugins: [
      {
        name: 'release',
        transform(report) {
          report.sections.push({
            id: 'release',
            title: 'Release',
            content: { release }
          })
        },
      },
    ],
  }
}
```

A plugin receives the report, and a context with the original `input` and the resolved `options`.

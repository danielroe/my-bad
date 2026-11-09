# API

This page lists the runtime exports of each entry point, with a link to the page that covers each one. Each entry point also exports the TypeScript types of its options and results.

## `my-bad`

| Export | Description |
| --- | --- |
| `createReport(input, options?)` | Builds a report from an error. See [Reports](./reports.md). |
| `createProblemReport(input, options?)` | Builds a report from a located diagnostic, without reading files. See [Publish problems](./problems.md#publish-a-problem-set). |
| `resolveOptions(options?)` | Returns the options that `createReport` uses after applying defaults and presets. |
| `renderPage(report, options?)` | Renders a complete HTML error page. See [Error page](./rendering.md#error-page). |
| `renderOverlay(report, options?)` | Renders an overlay to add to an existing page. See [Overlay](./rendering.md#overlay). |
| `injectOverlay(html, report, options?)` | Inserts the overlay into an HTML document. |
| `renderBadge(options)` | Renders the badge loader for every page. See [Badge](./rendering.md#badge). |
| `renderAnsi(report, options?)` | Renders a report for the terminal. See [Terminal output](./rendering.md#terminal-output). |
| `toMarkdown(report, options?)` | Renders a report as Markdown. See [Markdown and JSON](./rendering.md#markdown-and-json). |
| `serializeReport(report, options?)` | Returns a copy of a report for JSON responses, with paths inside `cwd` made relative. See [Markdown and JSON](./rendering.md#markdown-and-json). |
| `clientAssets` | The client script, stylesheet, and badge script, as strings. See [Serve the client assets separately](./rendering.md#serve-the-client-assets-separately). |
| `fsLoader(options?)` | Reads sources and source maps from disk. See [Map frames to original sources](./reports.md#map-frames-to-original-sources). |
| `sourceMapLoader(options)` | Maps frames through source maps held in memory. |
| `passthroughLoader()` | Reads sources without mapping frames. |
| `parseInlineSourceMap(code)` | Decodes the inline `sourceMappingURL` comment of generated code. |
| `mapPosition(map, raw, base, line, column)` | Resolves a generated position through a source map. |

## `my-bad/channel`

| Export | Description |
| --- | --- |
| `createChannel(options?)` | Creates a live channel. See [Live channel](./channel.md). |
| `openInEditor(request)` | Opens a file at a line in the editor of the user. See [Open files in an editor](./channel.md#open-files-in-an-editor). |
| `toHistoryEntry(report)` | Returns the history entry for a report: its id, kind, name, message, and timestamp. |

## `my-bad/sinks`

| Export | Description |
| --- | --- |
| `fileSink(path, options?)` | Appends channel events to a file as JSON lines. See [Record events with sinks](./channel.md#record-events-with-sinks). |
| `combineSinks(...sinks)` | Passes each event to several sinks. |

## `my-bad/presets`

| Export | Description |
| --- | --- |
| `requestPreset(options?)`, `h3Preset(options?)` | Adds request and header sections. See [Presets](./reports.md#presets). |
| `nitroPreset(options?)` | `requestPreset`, with Nitro and h3 frames marked as internal. |
| `vuePreset(options?)` | Adds a Vue component trace. |
| `envPreset(options?)` | Adds an environment section with versions. |
| `nuxtPreset(options?)` | Combines the presets above for Nuxt, and links Nuxt error codes. |
| `nuxtTheme` | A Nuxt theme for the HTML output. See [Theming](./rendering.md#theming). |
| `requestFromContext(context)` | Finds the request in a report context: an h3 event, a Fetch API `Request`, or a Node.js `IncomingMessage`. |
| `parseVueTrace(trace)` | Parses the `trace` string that Vue passes to `app.config.warnHandler`. |
| `traceFromInstance(instance)` | Builds a component trace from a Vue component instance. |

## `my-bad/vite`

| Export | Description |
| --- | --- |
| `myBad(options?)` | The Vite plugin. See [Use with Vite](./vite.md). |
| `useMyBad(server)` | Returns the context of the plugin for a dev server. See [Render server errors](./vite.md#render-server-errors). |
| `myBadDevTools(options)` | Adds the Vite DevTools dock for a channel outside the plugin. See [Add the dock for a channel outside the plugin](./vite.md#add-the-dock-for-a-channel-outside-the-plugin). |
| `viteLoader(server, options?)` | Maps frames through the Vite module graph. See [Map frames to original sources](./reports.md#map-frames-to-original-sources). |

## `my-bad/vite/client`

| Export | Description |
| --- | --- |
| `installMyBadClient(hot?, options?)` | Mounts the overlay that the Vite plugin pushes over HMR. See [Mount the client without `index.html`](./vite.md#mount-the-client-without-indexhtml). |

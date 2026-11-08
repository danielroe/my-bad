# Live channel

The channel keeps every page that renders a report or a badge up to date over SSE: errors swap in place, pages reload once their error is fixed, and warnings, logs, progress and problem sets stream in as they occur.

```ts
import { createChannel } from 'my-bad/channel'
import { fileSink } from 'my-bad/sinks'

const channel = createChannel({
  open: true,
  sink: fileSink('.nuxt/my-bad.jsonl')
})
```

`open: true` launches `LAUNCH_EDITOR` / `VISUAL` / `EDITOR` at the frame's line, falling back to the OS default app for common source and text files (never `.js` on Windows, where the default app runs it). `open` requests are confined to `root` (default `process.cwd()`; the Vite plugin uses `server.fs.allow`), must name an existing file, and must be `application/json`; pass `root: false` to allow any path. `open` may be a function instead, returning `false` to refuse a request.

## Mounting

In Node, mount the handler at the channel base path. Besides the live routes it serves `client.js`, `client.css`, `badge.js` and `devtools.js` (immutable when requested with `?v=`, as `renderBadge` does), the docked view at `panel` and, to trusted callers, every problem set in full at `problems`.

```ts
app.use('/__my-bad', (req, res, next) => {
  req.url = `/__my-bad${req.url}`
  channel.handler(req, res).then(handled => handled || next()).catch(next)
})

// or fetch-style
await channel.fetchHandler(request)
```

The channel refuses requests addressed to a host that is neither an IP literal, `localhost`, `*.localhost`, nor listed in `allowedHosts` (the Vite plugin passes `server.allowedHosts`), and requests a page on another origin made (`Sec-Fetch-Site`, else `Origin` must match the host addressed). Requests with neither header (`curl`, editor integrations) are allowed when addressed to such a host; a request naming no host is refused (`fetchHandler` falls back to the host of the request URL).

## Trust

Callers connecting from a loopback address (`req.socket.remoteAddress`, or `request.ip` for `fetchHandler`) are trusted by default and may browse every retained report. Any other peer, or one whose address is unknown, is untrusted (a `--host` binding, a connection forwarded into a container). The channel still connects and streams, but:

- its `hello.history` and the `history` payloads hold only the reports that concern the page (a report naming a request id is matched by that id alone, never by path)
- `/history/:id` responds 404 for any other report
- `/problems` responds 403 (problem sets reach it as counts only)
- log entries reach it only when attributed to a request that concerns it
- privileged actions such as `open` are neither advertised nor accepted, so the page opens an `editor://` URL on the machine running the browser instead

Pass `trusted` explicitly behind a proxy, where the peer address is the proxy's:

```ts
await channel.handler(req, res, {
  trusted: isLoopback(clientAddress(req))
})
```

## Publishing

```ts
channel.setError(report) // pages swap content in place; replaces every open error
channel.setError(report, requestId, `${method} ${url}`) // only pages rendered for that request swap; the rest list it in their history
channel.clearError(report.id) // retire one error: pages showing it reload or move on to the next open error that concerns them
channel.clearError() // retire every error: pages reload, overlays dismiss
channel.warn(report) // toast, and counted in the header until retired
channel.clearWarning(report.id) // retire it: pages drop it from their count and toasts (no id retires every warning)
channel.log({ level: 'warn', text: 'careful' }) // streamed to the log drawer of trusted callers
channel.log({ level: 'warn', text: 'careful' }, requestId, `${method} ${url}`) // also streamed to the pages that request concerns
channel.progress({ phase: 'build', percent: 40, message: 'Building server' }) // progress bar

// the current problems of a long-running source (type checker, linter, audit), replacing any it published before
channel.setProblems('typecheck', reports, { label: 'TypeScript', status: 'idle', url: '/__typecheck/' })
channel.clearProblems('typecheck') // retire one source (no source retires every one)

channel.setDevTools(true) // a my-bad dock is registered in Vite DevTools, so badges with `awaitHost` wait for it

const stop = channel.subscribe((event) => {}) // receive every event the `sink` receives, until `stop()`
```

## Problem sets

Problem sets stay out of `history` and the warning cap, raise no toasts and never take over a page. Republishing the same reports (by id and kind, in order) with the same meta is not broadcast again, so a source can publish after every run. Every page, trusted or not, receives a `problems` event per change carrying the source's error and warning counts but not its reports, and the counts of every set in `hello`. The sink also receives the reports that joined the set (`added`) and the ids of those that left it (`removed`), so a `fileSink` log records a problem when it joins the set rather than on every run. Sets belong to the channel, so a set replayed into a new channel is all `added` again. An empty set shows nothing, though its source stays listed with its meta.

With no `status` a source is idle; `status: 'checking'` shows a spinner while it runs, and `status: 'failed'` with an `error` reason replaces its count with `failed`, giving the reason in the pill's title. Sources with the same `group` are counted together under that name (`Nuxt 3`, or `Nuxt 2, 1 failed` when one of them failed), each listed in the title, as one entry opening the first of them. `channel.problems` returns every set in full.

Several sources may share one `url`, such as a tool serving one page for all its checkers. Each embeds it as given, so a source can add a query string the page understands (`/__checker/?tab=eslint`, say) to open it narrowed to its own problems.

A report's id hashes its name, message and the file, line and column of its first app frame, so build reports with `createReport` and pass the location: a compile-shaped input (`{ message, id, loc, frame }`) or `sources`, with `kind: 'warning'` for warnings, which are then named `Warning` unless the input has a name. `createReport` reads the file for a snippet, and lists a `sources` entry it cannot read in a `Sources` section rather than as a frame. For a tool that has already located its diagnostics, `createProblemReport` builds the report without reading anything, hashing its id the same way.

### Problems from another tool

A host feeds a tool's diagnostics in by mapping each run's results to reports and publishing the whole set. Any tool with a run lifecycle fits: a linter in watch mode, an a11y audit, or the server `api.subscribe` of vite-plugin-checker.

```ts
import type { ErrorReport } from 'my-bad'
import { createProblemReport } from 'my-bad'

const meta = { label: 'ESLint', url: '/__lint/' }
let reports: ErrorReport[] = []

linter.on('start', () => channel.setProblems('lint', reports, { ...meta, status: 'checking' }))
linter.on('results', (results) => {
  reports = results.map(result => createProblemReport({
    name: 'ESLint',
    message: result.message,
    code: result.ruleId,
    docsUrl: result.docsUrl,
    file: result.file,
    line: result.line,
    column: result.column,
    snippet: result.codeFrame,
    kind: result.severity === 2
      ? 'error'
      : 'warning',
  }))
  channel.setProblems('lint', reports, meta)
})
linter.on('crash', error => channel.setProblems('lint', reports, { ...meta, status: 'failed', error: error.message }))
linter.on('close', () => channel.clearProblems('lint'))
```

`createProblemReport` takes `name`, `message`, `code`, `docsUrl`, `file` (absolute, or relative to `cwd`), `line`, `column`, `kind` (`error` by default, or `warning`) and `snippet`, either a `Snippet` or a code frame of `3 | code` lines, which may mark a line with `>`. A report with no `file` or `snippet` has no frames.

The badge stays silent while a clean run checks, shows `ESLint 3` once there is something to count, and opens its problems, with `url` as the full list. Problems show on the pages that render the badge (`renderBadge`).

A problem's `name` heads it when it is opened, as an error's does. The drawer and the dock list each problem under its set's `label` (or `source`, without one), so a `name` that only repeats it (ignoring case) is left out of its row, and any other `name` (a diagnostic code such as `TS2322`, say) is shown before the message.

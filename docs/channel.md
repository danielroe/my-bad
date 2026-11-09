# Live channel

The live channel keeps open pages up to date over server-sent events (SSE). Your dev server publishes errors, warnings, logs, build progress, and problem sets to it. Every connected page then shows the ones that concern it.

The channel also serves the client scripts and stylesheet, the DevTools dock page, and stored reports. For a step-by-step setup, see [Integrate with a dev server](./dev-server.md).

## Create a channel

```ts
import { createChannel } from 'my-bad/channel'
import { fileSink } from 'my-bad/sinks'

const channel = createChannel({
  open: true,
  sink: fileSink('.nuxt/my-bad.jsonl'),
})
```

### Channel options

| Option | Default | Description |
| --- | --- | --- |
| `open` | Off | Let pages open files in an editor. Pass `true`, or a function. See [Open files in an editor](#open-files-in-an-editor). |
| `root` | `process.cwd()` | Directories that `open` requests are confined to. Pass `false` to allow any path. |
| `allowedHosts` | `[]` | Extra hosts that a browser may use to reach the channel. See [Who can use the channel](#who-can-use-the-channel). |
| `history` | `20` | Errors to keep. Warnings are kept until retired, up to the 100 most recent. |
| `sink` | | Receives every event. See [Record events with sinks](#record-events-with-sinks). |
| `keepalive` | `15000` | Milliseconds between keepalive messages. |

## Mount the channel

Pass each request under the channel base path to the handler. The handler resolves `true` when it handled the request.

With a Node.js server, or Connect-style middleware:

```ts
app.use((req, res, next) => {
  if (!req.url?.startsWith('/__my-bad/')) {
    return next()
  }
  channel.handler(req, res).then(handled => handled || next()).catch(next)
})
```

The handler needs the full path, so this example doesn't mount the middleware on a path. Connect removes the mount path from `req.url`.

With a Fetch API server, `fetchHandler` resolves `undefined` for paths it doesn't handle:

```ts
const response = await channel.fetchHandler(request)
```

The handler routes on the end of the path, so only pass it requests under the base path.

### Routes

| Route | Description |
| --- | --- |
| `GET {channel}/events` | The SSE stream. |
| `POST {channel}/open` | Opens a file in an editor, when `open` is set. |
| `GET {channel}/history/{id}` | A stored report, as JSON. Untrusted callers pass the `requestId` or `path` of their page as query parameters. |
| `GET {channel}/problems` | Every problem set in full, as JSON. Only for trusted callers. |
| `GET {channel}/panel` | The page that the badge drawer and the DevTools dock show. |
| `GET {channel}/client.js`, `client.css`, `badge.js`, `devtools.js` | The client assets. |

The channel caches an asset forever when the request names the hash of the current build in `?v=`, as `renderBadge` does. With any other hash, it serves the asset uncached.

## Who can use the channel

The channel checks every request, and treats each caller as trusted or untrusted.

### Hosts and origins

These checks protect against DNS rebinding and against pages on other origins. The channel refuses a request when either of these is true:

- The request addresses a host that isn't an IP address, `localhost`, a `*.localhost` subdomain, or an entry in `allowedHosts`.
- A page on another origin made the request.

The channel reads `Sec-Fetch-Site` to tell where a request came from. Without that header, the `Origin` header must match the host the request addresses. Requests with neither header, such as from `curl` or an editor integration, pass on the host check alone. A request that names no host is refused. For `fetchHandler`, the host falls back to the host of the request URL.

In `allowedHosts`, an entry that starts with `.` also matches subdomains. Pass `true` to accept any host. The Vite plugin passes `server.allowedHosts`.

### Trusted and untrusted callers

The channel trusts a caller that connects from a loopback address. It reads the address from `req.socket.remoteAddress`, or from `request.ip` for `fetchHandler`. A trusted caller can see every stored report, and can use actions such as `open`.

Any other caller is untrusted, including a caller whose address is unknown. This covers a dev server bound with `--host`, and a connection forwarded into a container. Untrusted callers still connect and receive updates, with these limits:

- History and `hello` hold only the reports that concern the page, each as published for a request of that page. A report that names a request id concerns only the page with that id, never a page with the same path.
- `/history/{id}` responds with a 404 for any other report.
- `/problems` responds with a 403. Problem sets reach the page only as counts.
- Log entries reach the page only when they belong to a request that concerns it.
- The channel neither offers nor accepts `open`. The page opens an `editor://` URL on the machine that runs the browser instead.

Errors from no request, and every warning, concern every page. Untrusted callers receive them in full, with their messages and source snippets.

Behind a proxy, the peer address is the address of the proxy. In that case, pass `trusted` yourself:

```ts
await channel.handler(req, res, {
  trusted: isFromThisMachine(req)
})
```

In this example, `isFromThisMachine` stands for your own check, for example of a forwarded client address. Only rely on a forwarded address that your proxy sets, and only when clients can't reach the server without the proxy. A client that sets the address itself can claim to be on the machine, and gain trusted access.

## Publish reports

Each method sends an update to the pages that it concerns.

```ts
channel.setError(report)
channel.setError(report, requestId, `${method} ${url}`)
channel.clearError(report.id)
channel.clearError(report.id, { requestId })
channel.clearError()

channel.warn(report)
channel.clearWarning(report.id)

channel.log({ level: 'warn', text: 'Slow response' })
channel.log({ level: 'warn', text: 'Slow response' }, requestId, `${method} ${url}`)

channel.progress({ phase: 'build', percent: 40, message: 'Building server' })

channel.setProblems('typecheck', reports, { label: 'TypeScript', url: '/__typecheck/' })
channel.clearProblems('typecheck')

channel.setDevTools(true)
```

| Method | Description |
| --- | --- |
| `setError(report, requestId?, request?)` | Publish an error. Each page shows the newest open error that concerns it, and swaps it in place. |
| `clearError(id?, request?)` | Retire one error, or every error without an id. With a `request`, retire it only for that request. Pages that showed it reload, or move on to the next open error that concerns them. Overlays close. |
| `warn(report)` | Publish a warning. Pages announce it, and count it until you retire it. |
| `clearWarning(id?)` | Retire one warning, or every warning without an id. |
| `log(entry, requestId?, request?)` | Publish a log entry. Levels are `trace`, `debug`, `info`, `log`, `warn`, `error`, and `fatal`. |
| `progress(progress)` | Publish build progress, shown as a progress bar. |
| `setProblems(source, reports, meta?)` | Publish the current problems of a source, replacing its earlier set. See [Publish problems](./problems.md). |
| `clearProblems(source?)` | Retire the problem set of one source, or of every source without one. |
| `setDevTools(registered)` | Record whether a `my-bad` dock is registered in Vite DevTools. See [Use with Vite](./vite.md#add-the-dock-for-a-channel-outside-the-plugin). |

### Errors and requests

An error can name the request that it came from, with a `requestId` and a `request` such as `GET /widgets`. It then reaches only the pages that the request concerns, and replaces only earlier errors from the same request. Other trusted pages list it in their history.

An error from no request reaches every page, and replaces every open error. Compile errors and client runtime errors usually have no request.

Several requests can raise the same error, with the same report id. The error then stays open on the page of each request, up to the 20 most recent requests. `clearError(id)` retires it for all of them. To retire it for one request, for example when that page renders again without the error, name the request:

```ts
channel.clearError(report.id, { requestId })
```

The pages of that request move on to their next open error, and the pages of other requests keep showing it. With only a `request`, such as `{ request: 'GET /widgets' }`, `clearError` retires the error for every request published with exactly that `request`, including the method and query: it leaves `GET /widgets?page=2` open. With both a `requestId` and a `request`, only the `requestId` counts. Without an id, it retires every error of the request.

The channel matches an error to a page like this:

- An error with a `requestId` matches a page rendered with the same `requestId`.
- An error with a `requestId` and a `request` matches a trusted page rendered without a `requestId` by its path. It never matches an untrusted page by path.
- An error with only a `request` matches any page by its path, even a page rendered with a `requestId`.

Path matching uses the path in `request`. An error published without a `request` never matches by path.

To keep errors on the page they belong to, pass the same id to `setError` and to the renderer.

A page names its own path when it connects, so any caller can receive the errors for a path that it guesses. When untrusted callers can reach the channel, publish errors with an unguessable `requestId`, such as one from `crypto.randomUUID()`.

### Logs

A log entry without a request reaches only trusted callers. A log entry with a request also reaches the pages that the request concerns.

### Build progress

Several tools can report progress at the same time. Give each one a `source`. The channel keeps the latest update from each source, and shows the least advanced one, so the bar doesn't jump backwards. An update with `percent: 100` retires its source.

## Read the channel state

| Member | Description |
| --- | --- |
| `current` | The newest open error. |
| `history` | Entries for every stored error and warning, whatever request it came from. |
| `historyFor(request)` | The entries that the channel sends a page rendered for a request. See [History for one page](#history-for-one-page). |
| `problems` | Every problem set, with its reports. |
| `getReport(id)` | A stored report. |
| `clients` | The number of connected pages. |
| `subscribe(listener)` | Receive the events that a sink receives, from now on. Returns a function that stops it. |
| `close()` | Stop the keepalive and disconnect every page. |

### History for one page

`historyFor` returns the history that the channel sends a page when it connects. Pass it to `renderPage` or `renderOverlay` as `history`, so the page lists its history before it connects:

```ts
res.end(renderPage(report, {
  channel: '/__my-bad',
  requestId,
  history: channel.historyFor({ requestId }),
}))
```

| Option | Default | Description |
| --- | --- | --- |
| `requestId` | | Id of the request that the page was rendered for. |
| `path` | | `pathname + search` of the page, for errors that name only a `request`. |
| `trusted` | `false` | Include the entries of every request, as `history` does. |

The entries follow the rules in [Errors and requests](#errors-and-requests) for an untrusted page. Unless you pass `trusted: true`, they never include errors from other requests.

## Record events with sinks

A sink receives the events that the channel publishes, as listed below. Use one to log events, write them to a file, or pass them to a coding agent.

```ts
import { combineSinks, fileSink } from 'my-bad/sinks'

const channel = createChannel({
  sink: combineSinks(
    fileSink('.nuxt/my-bad.jsonl'),
    event => console.log(event.type),
  ),
})
```

`fileSink(path)` appends each event as a line of JSON, with a timestamp. By default, it records every event except `build`. Pass `{ types }` to choose the event types. `combineSinks` passes each event to several sinks.

Pages receive these event types:

| Type | Sent when |
| --- | --- |
| `hello` | A page connects. |
| `error:set` | An error is published. |
| `error:clear` | An error is retired. |
| `history` | The history of a page changes. |
| `warning` | A warning is published. |
| `warning:clear` | A warning is retired. |
| `log` | A log entry is published. |
| `build` | Build progress is published. |
| `problems` | A problem set changes. |
| `problems:clear` | A problem set is retired. |

Sinks and `subscribe` listeners receive every type except `hello` and `history`. The channel sends those two to a single page. When you retire an error for one request, the `error:clear` event that sinks receive carries its `requestId` or `request`.

## Open files in an editor

Pages can open a file at the line of a frame. To turn this on, pass `open` to `createChannel`.

With `open: true`, the channel launches the editor named in `LAUNCH_EDITOR`, `VISUAL`, or `EDITOR`. It skips terminal editors, such as `vim`, `nvim`, and `nano`, because they need a terminal. To jump to the line, set `LAUNCH_EDITOR` to a GUI editor such as `code`. Without one, it falls back to the default app of the system, for common source and text files. On Windows, it never opens `.js` files this way, because the default app runs them. The same behaviour is available as `openInEditor` from `my-bad/channel`.

Pass a function to handle the request yourself. Return `false` to refuse it:

```ts
const channel = createChannel({
  open: ({ file, line, column }) => launchEditor(file, line, column),
})
```

In this example, `launchEditor` stands for your own function.

The channel refuses an `open` request in these cases:

- The caller isn't trusted.
- The request isn't a `POST` with an `application/json` body.
- The file doesn't exist.
- The file is outside `root`. The Vite plugin sets `root` to `server.fs.allow`.

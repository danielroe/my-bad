# Vite

```ts
import { myBad } from 'my-bad/vite'

export default defineConfig({
  plugins: [
    myBad()
  ]
})
```

The plugin maps frames through Vite's module graph, forwards compile errors from the HMR channel as `kind: 'compile'` reports, mounts the channel at `/__my-bad`, injects a tiny client into `index.html` so a running app shows the overlay, and clears it when the next update succeeds. Use `useMyBad(server)` from your own SSR middleware to build reports and pages with the same configuration. Sources are only read from disk where Vite would load them, following `server.fs.allow` and `server.fs.deny`.

The client script and stylesheet are served from `/__my-bad/client.js` and `/__my-bad/client.css` with content-hashed URLs, rather than inlined into every error page. Pass `inlineClient: true` for self-contained output.

## Vite DevTools

With [Vite DevTools](https://github.com/vitejs/devtools) installed, `myBad()` adds a my-bad dock to it, and nothing else needs configuring. Pass `devtools: false` to leave it out. Without Vite DevTools nothing changes.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/devtools-dark.png">
  <img src="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/devtools-light.png" alt="The my-bad dock open in Vite DevTools, listing the open error, a warning, three TypeScript errors and two ESLint warnings, with the error's hint and source snippet shown beside them">
</picture>

In DevTools, the badge shows on every page and opens the dock rather than the overlay, and errors no longer take over the page. The dock lists the open error, the warnings and every problem set, and shows the one picked the way the overlay does. Its icon in the DevTools bar counts them, in red while any is an error. The open error and each problem set also appear in the DevTools messages panel with their file position, showing a spinner while a set is `checking`, with actions to show them in the dock or show the set's full list. They raise no DevTools toast, since the badge announces them. A set's `devtoolsDock` names a DevTools dock listing its problems in full. The badge's entry for that set switches straight to it, and the full list actions switch to it in place of embedding its `url`. An entry counting a `group` of several sources still opens the my-bad dock.

When the channel lives outside the Vite plugin (a framework serving it from its own dev server, say), add `myBadDevTools` next to the badge that server renders:

```ts
import { myBadDevTools } from 'my-bad/vite'

export default defineConfig({
  plugins: [
    myBadDevTools({
      channel: '/__my-bad',
      onRegister: () => channel.setDevTools(true)
    })
  ]
})
```

The channel serves the dock's page at `{channel}/panel` and its script at `{channel}/devtools.js`. Until the DevTools client starts, the badge mounts the overlay for an error as usual; pass `renderBadge({ awaitHost: 3000 })` to give it up to that long to take over first. The badge only waits when the channel reports a registered dock in its `hello`, so pages without DevTools mount the overlay straight away. `myBad()` tells its own channel; with `myBadDevTools`, call `channel.setDevTools(true)` from `onRegister`, relaying it when the channel lives in another process. An untrusted DevTools client never runs the dock's script, so keep the wait short.

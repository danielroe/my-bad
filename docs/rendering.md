# Rendering

A report renders as a full HTML page (`renderPage`), an overlay for an existing page (`renderOverlay` / `injectOverlay`), a badge for every dev page (`renderBadge`), or ANSI for the terminal (`renderAnsi`).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/page-dark.png">
  <img src="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/page-light.png" alt="An error page showing the error name, message, hint, component trace and a syntax-highlighted source snippet with the failing line marked">
</picture>

## Overlay

Inject the error UI into an existing page (for example a framework's rendered error page). It renders in a shadow root, so host styles cannot leak in, and can be minimised to a picture-in-picture thumbnail so the user can see the page behind it.

```ts
import { injectOverlay } from 'my-bad'

html = injectOverlay(html, report, { channel: '/__my-bad', startMinimized: status < 500 })
```

`startMinimized: true` always mounts minimised, even if the user last expanded an overlay in this origin. Errors arriving over the channel leave the current minimised state alone.

Pass `requestId` alongside the same id given to `channel.setError` so the channel only sends this page the errors its own request produced. Without it the page's path is matched against the request instead. Errors published with no request (compile errors, client runtime errors) reach every page.

Use `injectOverlay` rather than `html.replace('</body>', ...)`: the inlined client contains `$` sequences that a string replacement would interpret.

## Serving the client separately

`renderPage` and `renderOverlay` inline the client script and stylesheet, which makes the output self-contained at the cost of ~60kB per response. The live channel serves them at `{channel}/client.js` and `{channel}/client.css` (or serve `clientAssets` yourself); pass the URLs to keep them out of the HTML and let the browser cache them:

```ts
import { renderPage } from 'my-bad'

renderPage(report, {
  channel: '/__my-bad',
  assets: { script: '/__my-bad/client.js', styles: '/__my-bad/client.css' }
})
```

Theme overrides stay inline, so a shared stylesheet still themes per response.

## Badge

`renderBadge` renders a small loader for every dev page, which shows errors, warnings and problem sets as they arrive; its ~19kB script comes from the channel at `{channel}/badge.js`. It renders nothing until something concerns the page. An error mounts the overlay, minimised unless `startMinimized: false`, loading it from the channel. Warnings show a small count in the corner the overlay docks to, which expands into a panel beside the page when clicked; with no error to show, the panel leaves the page usable, and moves on to the next warning as each one is retired. The count stands in for the overlay whenever it is hidden or cleared. A new warning, or a new error while the overlay is hidden, grows the count into a card showing it and where it points for a few seconds, held open while hovered or focused; clicking the card does what clicking the count does.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/badge-dark.png">
  <img src="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/badge-light.png" alt="A card in the corner of a page showing the newest warning, NUXT_B4025: <NuxtLink> has both to and href, with components/AppNav.vue:12 beneath it" width="428">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/warnings-dark.png">
  <img src="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/warnings-light.png" alt="The warnings panel beside a page, showing a deprecation warning with its source snippet">
</picture>

Problem sets from type checkers, linters and compilers (see [problem sets](./channel.md#problem-sets)) are counted per source, or per `group` of sources, in a second pill beside it, which spins while a source is checking, reads `failed` for a source that could not run, and opens the source's problems in a drawer beside the badge, with its `url` as the full list. They never mount the overlay. New reports grow the pill into the same card, showing the first of them and how many more arrived with it, on pages the channel serves reports to (see [trust](./channel.md#trust)).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/badge-problems-dark.png">
  <img src="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/badge-problems-light.png" alt="A small pill in the corner of a page reading vue-tsc 3, ESLint 2, with a spinner while ESLint is checking" width="203">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/drawer-dark.png">
  <img src="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/drawer-light.png" alt="The problems drawer beside a page, listing a warning, three TypeScript errors and two ESLint warnings, with the first TypeScript error and its source snippet shown beside them">
</picture>

```ts
import { renderBadge } from 'my-bad'

// anywhere in every dev page
html += renderBadge({ channel: '/__my-bad', requestId })

// in the page, to reload once its error is fixed
addEventListener('my-bad:error:clear', () => location.reload())
```

Pass `assets: { script, styles, badge }` to load any of them from your own URLs instead.

The channel serves its own build of the scripts and stylesheet: requested with that build's `?v=` hash they are cached for good, and with any other hash they are served uncached. A page rendered by a different version of `my-bad` than the one owning the channel (a framework whose CLI owns it, say) therefore still loads a matching badge and overlay. A channel from a version without `badge.js` responds 404, so pass `assets` when the channel's version is out of your hands.

It takes the same `theme`, `tag`, `cwd`, `editor` and `dock` options as the overlay; `dock` picks the corner (`bottom-right` by default) that the badge and the minimised overlay start in, until the user moves them. An overlay rendered into the same page with the same `tag` (an error page using `injectOverlay`, say) is adopted rather than duplicated and shares the badge's connection. The badge closes that connection while the tab is in the background.

## Theming

The page is dark by default and follows `prefers-color-scheme`. Everything is derived from a handful of CSS custom properties, so it's possible to restyle it without forking the stylesheet:

```ts
import { renderPage } from 'my-bad'
import { nuxtTheme } from 'my-bad/presets'

renderPage(report, { theme: nuxtTheme })

renderPage(report, {
  theme: {
    name: 'Acme',
    url: 'https://acme.dev',
    logo: '<svg viewBox="0 0 32 32">…</svg>', // drawn at 20px in currentColor
    accent: '#ff4f81',
    vars: { '--mb-bg': '#0b0b12', '--mb-font-sans': 'Inter, sans-serif' },
    css: '.mb-name { text-transform: uppercase }',
    scheme: 'dark', // force a scheme instead of following the user
  },
})
```

Tokens: `--mb-accent`, `--mb-bg`, `--mb-fg`, `--mb-font-sans`, `--mb-font-mono`, `--mb-radius`, plus the `--mb-tk-*` syntax colours. Text tiers, hairlines and surfaces are mixed from those, and the accent is deepened automatically for small text on light backgrounds.

## Terminal

```ts
console.error(renderAnsi(report, { cwd, icon: false })) // `icon: false` when your logger prints its own badge
```

File locations are OSC 8 hyperlinks (via `clickable-path`) in terminals that support them.

<img src="https://raw.githubusercontent.com/danielroe/my-bad/main/assets/ansi.svg" alt="Terminal output showing the error, a hint, the component trace, source snippets for the error and its cause, and the collapsed stack frames">

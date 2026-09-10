# Live Nuxt error screen playground

Run from the repository root after installing the workspace dependencies:

```sh
pnpm install
pnpm play:prototypes
```

Open http://127.0.0.1:4330. This launches the prototype shell and a real Nuxt 4 development server using the workspace's Nuxt fixture dependencies, including its actual `@nuxt/devtools` installation. `PORT` changes the shell port; Nuxt uses an available local port automatically. Stop both with Ctrl+C.

## Three directions, one running app

| Prototype | Exploration |
| --- | --- |
| Focus | Error first, with its source kept in place and diagnostics on demand. |
| Workbench | Persistent issue list alongside the same compact error inspector. |
| Trace | A causal sequence with source expanded inside each step; single errors open directly into the call stack. |

One compact toolbar switches prototypes and scenarios. Extra testing controls live under Options. The app is a small employee directory with fictional records. Search and department filters work, profiles open in a dialog, and edits are validated and saved through a real Nitro API. Employee data is held in server memory: it survives page reloads and resets when Nitro restarts. There is no custom floating badge. Switching a design preserves the running app and reports. View and theme are bookmarkable URL parameters. The error page uses unmodified SVG icon-and-wordmark lockups from https://nuxt.com/design-kit. Brand green is `#00DC82`; the SVG preserves Nuxt’s own spacing and wordmark geometry.

## Understandable failures

Start with **Working directory**. The main scenarios describe ordinary employee-directory actions:

| Scenario | What to do | Failure |
| --- | --- | --- |
| Load employees | Select the scenario | One record is missing a name; the directory reports one error with that validation cause. |
| Open profile | Click View profile | A profile is missing when the app reads its name. |
| Save changes | Edit the open profile and save | A missing department makes cost-center lookup throw a native TypeError; the save operation preserves it as a cause. |
| Refresh employees | Click Refresh employees | A truncated employee export makes JSON.parse throw a native SyntaxError in the server. |
| Employee not found | Select the scenario | A missing employee produces Nuxt's 404 page. |
| Broken page template | Select the scenario | A missing closing tag in DirectoryHeader.vue triggers the Vue compiler. |

**Edge cases** is a separate scenario group for hydration, an invalid employee-count prop, import validation errors, a restore → read → JSON parsing cause chain, missing stacks, long messages, special characters, and independent sync failures. All import scenarios and the sync scenario use the corresponding app buttons. Import errors come from validating rows; the sync jobs independently parse an export, resolve a profile, and format a timestamp. These are deliberate stress tests, not a claim that ordinary errors contain many failures. A nested cause is part of one reported error; an AggregateError groups related errors; the sync test explicitly collects independent reports.

The same employee domain is used throughout the app, messages, and source snippets. The common two-error case uses a simple **Caused by** link with a way back, without the numbered chain used by the deeper test case.

**Apply fix** edits a real file, waits for Nuxt's server rebuild, and rerenders the app. Reports move into history after a successful mounted render. **Source** opens the disposable app's files: save changes to exercise HMR, and reload to retry SSR failures. File names in reports open that editor; the external arrow uses my-bad's native editor launcher.

The preview contains a persistent Nuxt iframe. Use **Hide error** in the toolbar to interact with the app; **Show error** restores the report. Real Nuxt DevTools is enabled in the Nuxt app: use its native bottom-center toggle or keyboard shortcut while viewing the app. The prototype error page is not labeled as DevTools. Full page and overlay presentations use the same captured reports. Options → Viewport resizes the actual preview iframe, including 320px. Latency delays real app HTTP requests; it is not a bandwidth or CPU throttle. Disconnect pauses the error screen's SSE connection while the app and outer controls keep running. Reconnect fetches the current state.

Copy Markdown, JSON, or an agent prompt from a real report. Inspect original and compiled source, framework frames, component traces, server logs, request headers, installed versions, and previous issues. History is bounded and lasts until the playground server stops. Arrow keys navigate issues; Escape hides the screen. Previous errors are available under Options. Form fields and code blocks keep their normal keyboard behavior.

## Implementation

- `server.ts`: launches Vite and Nuxt, captures reports, provides the source editor API and SSE channel.
- `nuxt-app/`: tracked Nuxt application template.
- `../out/nuxt-live/`: disposable runtime copy; restarting the playground resets its source files.
- `shell.ts`, `shell.css`: outer playground controls.
- `main.ts`, `screen.css`, `style.css`, `tokens.css`: the three report views.
- `data.ts`: scenario catalog and live state types, with no canned reports.

The healthy directory uses `shared/employees.ts`, `EmployeeTable.vue`, and the real `server/api/employees` routes. `shared/scenario-inputs.ts` supplies invalid input to normal app operations in `shared/directory.ts` and `shared/employee-import.ts`. The save scenario supplies an incomplete department catalog to cost-center resolution. `shared/faults.ts` only controls injection; applying a fix edits that flag. Faults remain deterministic fixtures, but the exceptions, cause chains, and call stacks come from executing the app code. The CSV sample reader supports the simple, unquoted sample rows; it is not a general-purpose CSV parser.

The harness reuses my-bad's report creation, Nuxt preset, source loaders, Markdown serializer, syntax highlighting, channel, and the Nuxt fixture's Nitro adapter. Browser source maps are fetched from the running Nuxt server and refreshed for each report. Vue warnings can lack an exact source line; the screen says so and provides the component trace. Local source edits are confined to the disposable runtime and exclude generated files and dependencies.

These remain prototype renderers, separate from the shipped error page. The playground is intended for one local reviewer: scenarios and history are shared across its browser tabs. It exercises development behavior, not production deployments, multiple Nuxt versions, offline caching, or browser-specific engine differences.

## Shared information hierarchy

This iteration is a design proposal to evaluate against the research, not a claim that every error should use the same presentation.

| Placement | Elements | Reason |
| --- | --- | --- |
| Immediately visible | Message, error type, server/client, copy, source location and editor action, up to seven source lines | Identify the failure and act on it. |
| Compact navigation | Root cause and outer error; intermediate wrappers or aggregate siblings expand on demand | Preserve causal context without a permanent sidebar. |
| On demand | Call stack, framework frames, component trace, request/environment, logs, history | Useful supporting evidence without competing with the failure. |
| Removed from all three views | Single-issue pager, sidebar instructions, repeated route, source-map status row, permanent status footer, ornamental purple | Repeated or explanatory material does not need to occupy the first view. |

Multiple-issue navigation and hydration differences remain visible when they are relevant. No-stack and source-unavailable reports retain explicit explanations. Copying exports the full report regardless of which disclosures are open. Focus starts at the reported error; Trace keeps the reported error as its heading and opens the first cause with available source inside a sequence of expandable error steps; Workbench keeps the issue list alongside the inspector. Focus and Workbench share the single-error inspector. Trace uses a separate sequence layout, with one error step open at a time and every wrapper still visible. Aggregate errors are labeled as related errors rather than a causal sequence. Shared controls retain the same behavior across all three.

Call-stack rows open a local preview immediately below the selected row, with a single toolbar and an even inset on both sides. The main error source stays in place. The row remains highlighted while open; click it again or use Close frame preview to collapse it. The non-interactive Shown above row identifies the source already visible. A framework switch sits beside the call-stack disclosure; it filters framework rows without changing the open state. Source/compiled and context choices are scoped to each frame. Context starts compact (three lines per side); More context expands to the full captured excerpt (normally five per side), and Less context collapses it again. Short excerpts omit the control if nothing can be collapsed. Tabs render at two columns without changing the underlying source text. Editor actions always use the original mapped coordinates, including while viewing compiled JavaScript; frames without an available source do not offer a misleading editor action.

The disposable Nuxt app includes the standard references to Nuxt’s generated TypeScript projects so shared files are checked with the correct language target in the editor.


In Trace, the reported error heading stays fixed as a reference while source is expanded inside its causal step. Only one step is open at a time. Without a cause chain, Trace opens the call stack directly with the error frame expanded inline; Focus keeps its source above a collapsed stack. If no stack exists, both preserve the explicit unavailable-state explanation rather than inventing a trace.


Focus and Workbench use stable, numbered Root cause / Wrapped error / Reported error navigation. The selected wrapper stays visible in the collapsed picker, alongside its position in the complete chain and the original reported message. The picker lists every error in causal order and checks the current selection. Aggregate entries remain labeled as related errors. Escape and outside clicks dismiss the picker. Call stack and Component trace use identical disclosure buttons; the independent switch is labeled Show framework frames.

## Annotated before / after

Open `http://127.0.0.1:4330/review/index.html` for the review canvas. It pairs the default library renderer with Focus using the same real reports and viewport. Screenshots enlarge on click; annotations can be hidden; technical notes expand beneath each pair. Each section also offers an annotated PNG download with its technical notes included. Print / PDF includes those notes.

The review separates changes to existing features from additions, calls out prototype gaps, and maps the proposed port to the library renderer. The Nuxt fixture and harness are outside that port.

To refresh the captures after starting the playground:

```sh
pnpm build
node playground/prototypes/capture-review.mjs
```

The command captures current playground reports and history. To reuse a previous capture, pass its local `public/review/capture-state.json` as an argument. The missing-profile and nested-cause scenarios must have been captured. This runs the real renderers with frozen transport, normalizes local home paths, and writes matched screenshots and capture metadata to `public/review/`. It does not change the active playground scenario. The review folder can be served as a static site; live playground links require the development server.

To prepare the review for a static host or share it as one HTML file:

```sh
node playground/prototypes/package-review.mjs
```

This writes `playground/out/design-review/index.html` for hosting and `public/review/my-bad-review.html` for the review’s download link. All screenshots, annotated PNG boards, styles, scripts and capture metadata are embedded. The shared artifact makes no network requests and replaces local-playground links with explanatory text. Run the capture command first whenever the visual comparisons change, then package again. Hosting destination and public/team-only access are chosen separately; generating the artifact does not publish it.

Public review: https://my-bad-design-review.vercel.app

Vercel project: `hrcd/my-bad-design-review`. Deploy only the packaged directory after refreshing captures and running `package-review.mjs`. Its `.vercelignore` allows only `index.html` and `vercel.json`; the local Nuxt app and captured report JSON are not deployed.

Generated screenshots, annotated boards, capture data, metadata, and the self-contained HTML export are ignored by Git. Only the authored review HTML/CSS/JS and the capture/package scripts are versioned. `playground/out/` and Vercel project metadata are also ignored; generate captures before opening the local review on a fresh checkout.

### Stack prototype

Choose **Stack** in the Prototype selector for a continuous source sheet. The first captured frame stays visible; opening Call stack expands the other application frames in place. Frame numbers retain their original positions, with omitted framework ranges marked. Framework frames without captured source use compact rows. Source/Compiled, context, editor links, causes, copy, logs, history, and page preview use the same live reports and controls as the other prototypes.

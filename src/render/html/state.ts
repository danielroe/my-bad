import type { ErrorReport, HistoryEntry } from '../../types'

export interface Theme {
  /** Product name shown in the header. */
  name?: string
  /** Inline SVG markup for the header, drawn at 20px tall in `currentColor`. Trusted; not escaped. */
  logo?: string
  /** Link for the brand lockup, e.g. the framework homepage. */
  url?: string
  /** Accent colour, any CSS colour. Drives links, the active line, the progress bar and focus rings. */
  accent?: string
  /** Force a colour scheme instead of following the user's preference. */
  scheme?: 'light' | 'dark'
  /**
   * Extra CSS custom properties set on the root, e.g. `{ '--mb-bg': '#020420' }`.
   * See `styles.css` for the full list of tokens.
   */
  vars?: Record<string, string>
  /** Extra CSS appended after the built-in stylesheet. Trusted; not escaped. */
  css?: string
}

export interface PageState {
  mode: 'page' | 'overlay'
  report: ErrorReport
  cwd?: string
  /** Base path of the live channel, e.g. `/__my-bad`. Enables SSE and actions. */
  channel?: string
  history?: HistoryEntry[]
  theme?: Theme
  /** Mount minimised regardless of the user's remembered preference. */
  startMinimized?: boolean
  /** Custom element tag name hosting the overlay. */
  tag?: string
  /** URL scheme used to open files when the channel has no `open` action. */
  editor?: string
  /** CSS applied to the overlay shadow root. */
  styles?: string
  /** URL of a stylesheet to load into the overlay shadow root, alongside `styles`. */
  stylesUrl?: string
  version: string
}

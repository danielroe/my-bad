import type { ProblemSummary } from '../../channel/protocol'
import type { ErrorReport, HistoryEntry } from '../../types'

/** `localStorage` key holding the colour scheme the user picked. */
export const THEME_STORAGE_KEY = 'my-bad:theme'

export interface Theme {
  /** Product name shown in the header. */
  name?: string
  /** Inline SVG markup for the header, drawn at 20px tall in `currentColor`. Trusted; not escaped. */
  logo?: string
  /** Link for the brand lockup, e.g. the framework homepage. */
  url?: string
  /** Accent colour, any CSS colour. Drives links, selected controls, the progress bar and focus rings. */
  accent?: string
  /** Force a colour scheme instead of following the user's preference. */
  scheme?: 'light' | 'dark'
  /**
   * Extra CSS custom properties set on the root, e.g. `{ '--mb-bg': '#0a0a0a' }`.
   * See `styles.css` for the full list of tokens.
   */
  vars?: Record<string, string>
  /** Extra CSS appended after the built-in stylesheet. Trusted; not escaped. */
  css?: string
}

export type Dock = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

export interface PageState {
  environment?: string
  mode: 'page' | 'overlay' | 'docked'
  report: ErrorReport
  cwd?: string
  /** Base path of the live channel, e.g. `/__my-bad`. Enables SSE and actions. */
  channel?: string
  history?: HistoryEntry[]
  theme?: Theme
  /** Mount minimised regardless of the user's remembered preference. */
  startMinimized?: boolean
  /** Corner the overlay docks to until the user moves it. */
  dock?: Dock
  /** Custom element tag name hosting the overlay. */
  tag?: string
  /** URL scheme used to open files when the channel has no `open` action. */
  editor?: string
  /** Characters of the message shown before it has to be expanded. */
  maxMessageLength?: number
  /** Correlation id of the request this page was rendered for. */
  requestId?: string
  /** CSS applied to the overlay shadow root. */
  styles?: string
  /** URL of a stylesheet to load into the overlay shadow root, alongside `styles`. */
  stylesUrl?: string
  version: string
}

/** The view docked into a host such as a DevTools panel: every open report, one shown in full. */
export interface DockedState extends Omit<PageState, 'mode' | 'report'> {
  mode: 'docked'
  /** Take the scope, theme and paths of the badge on the embedding page. */
  embed?: boolean
  /** Shown in the badge's drawer, which the view can close. */
  drawer?: boolean
  /** The embedding page's host can switch to another dock. */
  docks?: boolean
  /** The channel withholds problem reports from this page, which is not on the dev server's machine. */
  withheld?: boolean
}

/** What a docked view lists. Problem sets carry their reports once fetched. */
export interface DockedIndex {
  current?: ErrorReport
  history: HistoryEntry[]
  problems: Array<ProblemSummary & { reports?: ErrorReport[] }>
}

/** What the badge has received from the channel, for a script that attaches after it connected. */
export interface BadgeSnapshot {
  /** Whether the channel has greeted the badge, so the rest reflects it. */
  ready: boolean
  connected: boolean
  actions: string[]
  overlay: BadgeState['overlay']
  current?: ErrorReport
  history: HistoryEntry[]
  /** Problem sets, with their reports once fetched. Pages the channel withholds reports from get none. */
  problems: Array<ProblemSummary & { reports?: ErrorReport[] }>
}

/** Which report or problem set to show. */
export interface BadgeFocus {
  id?: string
  source?: string
  /** Show the problem set's full list rather than one of its reports. */
  list?: boolean
}

export interface BadgeState {
  /** The overlay the badge expands into, short of its report. */
  overlay: Omit<PageState, 'report'>
  /** URL of the overlay client script. */
  script: string
  /** Start even when an overlay client is already listening, because a host such as DevTools mounted the badge. */
  hosted?: boolean
  /** Milliseconds to wait for a host such as DevTools to take over before mounting the overlay for an error, when the channel reports a registered dock. */
  awaitHost?: number
}

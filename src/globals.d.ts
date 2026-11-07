/** Package version, substituted at build time. */
declare const __MY_BAD_VERSION__: string

/** The badge's channel stream, re-dispatching every channel event under its own type. */
interface MyBadSharedSource extends EventTarget {
  /** Absolute `/events` URL, scope included. */
  readonly url: string
  close: () => void
  /** What the badge has received so far, for a script that attaches after it connected. */
  snapshot?: () => import('./render/html/state').BadgeSnapshot
  /** Set by a host that shows details itself, such as a DevTools dock. The badge then opens it instead of the overlay. */
  host?: { open: (focus: import('./render/html/state').BadgeFocus) => void }
}

interface Window {
  /** Set by a client listening to the channel, so the Vite HMR client does not mount a second one. */
  __MY_BAD_CLIENT__?: boolean
  /** Set by the badge, so an overlay on the same page reuses its stream instead of opening another. */
  __MY_BAD_SOURCE__?: MyBadSharedSource
}

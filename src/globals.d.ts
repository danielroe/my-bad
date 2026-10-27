/** Package version, substituted at build time. */
declare const __MY_BAD_VERSION__: string

/** The badge's channel stream, re-dispatching every channel event under its own type. */
interface MyBadSharedSource extends EventTarget {
  /** Absolute `/events` URL, scope included. */
  readonly url: string
  close: () => void
}

interface Window {
  /** Set by a client listening to the channel, so the Vite HMR client does not mount a second one. */
  __MY_BAD_CLIENT__?: boolean
  /** Set by the badge, so an overlay on the same page reuses its stream instead of opening another. */
  __MY_BAD_SOURCE__?: MyBadSharedSource
}

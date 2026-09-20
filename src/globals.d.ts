/** Package version, substituted at build time. */
declare const __MY_BAD_VERSION__: string

interface Window {
  /** Set by a client listening to the channel, so the Vite HMR client does not mount a second one. */
  __MY_BAD_CLIENT__?: boolean
}

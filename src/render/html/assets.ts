import { fnv1a64Base36 } from 'fnv1a-64'
import { getBadgeScript, getClientScript, getClientStyles } from 'virtual:my-bad-client'

/**
 * The client script and stylesheet that `renderPage` and `renderOverlay` inline
 * by default, and the badge script, for serving them yourself and passing the
 * URLs as `assets`. The channel also serves all three under its base path.
 */
export const clientAssets: { script: string, styles: string, badge: string } = {
  get script() {
    return getClientScript()
  },
  get styles() {
    return getClientStyles()
  },
  get badge() {
    return getBadgeScript()
  },
}

/** Path under a channel base, content type and source of each asset. */
export const ASSET_FILES: Record<'script' | 'styles' | 'badge', readonly [file: string, type: string, source: () => string]> = {
  script: ['client.js', 'text/javascript', () => clientAssets.script],
  styles: ['client.css', 'text/css', () => clientAssets.styles],
  badge: ['badge.js', 'text/javascript', () => clientAssets.badge],
}

const hashes = new Map<string, string>()

export function assetHash(key: keyof typeof ASSET_FILES): string {
  let hash = hashes.get(key)
  if (!hash) {
    hash = fnv1a64Base36(ASSET_FILES[key][2]())
    hashes.set(key, hash)
  }
  return hash
}

/** Content-hashed URLs of the assets under `base`, so they can be cached indefinitely. */
export function assetUrls(base: string): { script: string, styles: string, badge: string } {
  const url = (key: keyof typeof ASSET_FILES) => `${base}/${ASSET_FILES[key][0]}?v=${assetHash(key)}`
  return { script: url('script'), styles: url('styles'), badge: url('badge') }
}

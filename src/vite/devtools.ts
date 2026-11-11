import type { Plugin } from 'vite'
import { assetUrls } from '../render/html/assets'
import { DOCKED_TITLE } from '../render/html/state'

export interface MyBadDevToolsOptions {
  /** Base path of the channel, e.g. `/__my-bad`. It serves the dock's page and script. */
  channel: string
  /** Default `my-bad`. */
  id?: string
  /** Default `Problems`. */
  title?: string
  /** An Iconify name or an image URL. */
  icon?: string
  /**
   * Called once Vite DevTools registers the dock. Tell the channel with
   * `channel.setDevTools(true)`, directly or through whatever connects this
   * process to the one owning the channel, so a badge rendered with
   * `awaitHost` waits for DevTools only when the dock exists.
   */
  onRegister?: () => void
}

/** The part of the Vite DevTools setup context the dock uses, so the published types do not depend on `@vitejs/devtools-kit`. */
export interface DockHost {
  docks: {
    register: (entry: {
      id: string
      type: 'iframe'
      title: string
      icon: string
      url: string
      clientScript: { importFrom: string, eager: boolean }
    }) => unknown
  }
}

export type DevToolsPlugin = Plugin & { devtools?: { setup: (ctx: DockHost) => void } }

export function registerDock(ctx: DockHost, options: Omit<MyBadDevToolsOptions, 'onRegister'> & { clientScript?: string }): void {
  ctx.docks.register({
    id: options.id ?? 'my-bad',
    type: 'iframe',
    title: options.title ?? DOCKED_TITLE,
    icon: options.icon ?? 'ph:bug-beetle-duotone',
    url: `${options.channel}/panel?embed${options.title
      ? `&title=${encodeURIComponent(options.title)}`
      : ''}`,
    clientScript: {
      importFrom: options.clientScript ?? assetUrls(options.channel).devtools,
      eager: true,
    },
  })
}

/**
 * Add a my-bad dock to Vite DevTools, for a channel served outside the Vite
 * plugin, such as by a framework's dev server. The badge on each page opens
 * the dock, and errors and problems appear in DevTools messages. Without Vite
 * DevTools, the plugin does nothing.
 */
export function myBadDevTools(options: MyBadDevToolsOptions): Plugin {
  const plugin: DevToolsPlugin = {
    name: 'my-bad:devtools',
    apply: 'serve',
    devtools: {
      setup(ctx) {
        registerDock(ctx, {
          channel: options.channel,
          id: options.id,
          title: options.title,
          icon: options.icon,
        })
        options.onRegister?.()
      },
    },
  }
  return plugin
}

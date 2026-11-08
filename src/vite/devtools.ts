import type { Plugin } from 'vite'
import { assetUrls } from '../render/html/assets'

export interface MyBadDevToolsOptions {
  /** Base path of the channel, e.g. `/__my-bad`. It serves the dock's page and script. */
  channel: string
  /** Default `my-bad`. */
  id?: string
  /** Default `my-bad`. */
  title?: string
  /** An Iconify name or an image URL. */
  icon?: string
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

export function registerDock(ctx: DockHost, options: MyBadDevToolsOptions & { clientScript?: string }): void {
  ctx.docks.register({
    id: options.id ?? 'my-bad',
    type: 'iframe',
    title: options.title ?? 'my-bad',
    icon: options.icon ?? 'ph:bug-beetle-duotone',
    url: `${options.channel}/panel?embed`,
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
      setup: ctx => registerDock(ctx, options),
    },
  }
  return plugin
}

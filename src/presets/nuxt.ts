import type { Theme } from '../render/html/state'
import type { ReportPreset } from '../types'
import { envPreset } from './env'
import { nitroPreset } from './h3'
import { vuePreset } from './vue'

export interface NuxtPresetOptions {
  /** Versions for the environment section. */
  versions?: Record<string, string | undefined>
  /** Base URL for error code documentation. */
  docsBase?: string
  redact?: string[]
}

const NUXT_CODE_RE = /^[BE]\d{4}$/i

/**
 * Nuxt support: error codes linked to docs, Nuxt/Nitro/Vue internals collapsed,
 * request and route sections, and Vue component traces.
 */
export function nuxtPreset(options: NuxtPresetOptions = {}): ReportPreset {
  const docsBase = (options.docsBase ?? 'https://nuxt.com/docs/errors/').replace(/\/?$/, '/')
  const parts = [vuePreset(), nitroPreset({ redact: options.redact }), envPreset({ versions: options.versions })]
  return {
    internal: [
      /\/node_modules\/(?:nuxt|@nuxt|nuxt-nightly|@nuxt\/[^/]+|unctx|hookable|ofetch|vue-router)\//,
      /^(?:nuxt|nuxt-nightly|unctx|hookable|ofetch|vue-router|@nuxt\/[^/]+)$/,
      /\/\.nuxt\/(?:dev\/|dist\/server\/)/,
      /#app\//,
      /^(?:callWithNuxt|applyPlugin|applyPlugins|executeAsync|runWithContext|callAsync|createError|showError)$/,
      ...parts.flatMap(part => part.internal ?? []),
    ],
    plugins: [
      ...parts.flatMap(part => part.plugins ?? []),
      {
        name: 'nuxt',
        transform(report, ctx) {
          const visit = (node: typeof report) => {
            if (node.code && NUXT_CODE_RE.test(node.code) && !node.docsUrl) {
              node.docsUrl = `${docsBase}${node.code.toLowerCase()}`
            }
            node.causes.forEach(visit)
            node.errors?.forEach(visit)
          }
          visit(report)

          const route = ctx.options.context.route as { path?: string, name?: string | symbol, fullPath?: string, matched?: Array<{ path?: string, name?: string | symbol }>, meta?: Record<string, unknown> } | undefined
          if (route && !report.sections.some(section => section.id === 'route')) {
            const content: Record<string, unknown> = {}
            if (route.fullPath ?? route.path) {
              content.path = route.fullPath ?? route.path
            }
            if (route.name) {
              content.name = String(route.name)
            }
            if (route.matched?.length) {
              content.matched = route.matched.map(record => String(record.name ?? record.path)).join(' › ')
            }
            const layout = route.meta?.layout
            if (layout) {
              content.layout = String(layout)
            }
            const middleware = route.meta?.middleware
            if (Array.isArray(middleware) && middleware.length) {
              content.middleware = middleware.map(item => typeof item === 'string' ? item : (item as { name?: string }).name ?? '[fn]').join(', ')
            }
            const index = report.sections.findIndex(section => section.id === 'headers' || section.id === 'env')
            report.sections.splice(index === -1 ? report.sections.length : index, 0, { id: 'route', title: 'Route', content })
          }
        },
      },
    ],
  }
}

/**
 * Nuxt brand for `renderPage` / `renderOverlay`: green accent on navy, with the
 * icon lockup in the header.
 */
export const nuxtTheme: Theme = {
  name: 'Nuxt',
  url: 'https://nuxt.com',
  accent: '#00dc82',
  vars: { '--mb-bg': '#020420', '--mb-fg': '#ffffff' },
  logo: '<svg viewBox="0 0 48 32" aria-hidden="true"><path d="M26.88 32H44.64C45.2068 32.0001 45.7492 31.8009 46.24 31.52C46.7308 31.2391 47.2367 30.8865 47.52 30.4C47.8033 29.9135 48.0002 29.3615 48 28.7998C47.9998 28.2381 47.8037 27.6864 47.52 27.2001L35.52 6.56C35.2368 6.0736 34.8907 5.72084 34.4 5.44C33.9093 5.15916 33.2066 4.96 32.64 4.96C32.0734 4.96 31.5307 5.15916 31.04 5.44C30.5493 5.72084 30.2032 6.0736 29.92 6.56L26.88 11.84L20.8 1.59962C20.5165 1.11326 20.1708 0.600786 19.68 0.32C19.1892 0.0392139 18.6467 0 18.08 0C17.5133 0 16.9708 0.0392139 16.48 0.32C15.9892 0.600786 15.4835 1.11326 15.2 1.59962L0.32 27.2001C0.0363166 27.6864 0.000246899 28.2381 3.05588e-07 28.7998C-0.000246288 29.3615 0.0367437 29.9134 0.32 30.3999C0.603256 30.8864 1.10919 31.2391 1.6 31.52C2.09081 31.8009 2.63324 32.0001 3.2 32H14.4C18.8379 32 22.068 30.0092 24.32 26.24L29.76 16.8L32.64 11.84L41.44 26.88H29.76L26.88 32ZM14.24 26.88H6.4L18.08 6.72L24 16.8L20.0786 23.636C18.5831 26.0816 16.878 26.88 14.24 26.88Z"/></svg>',
}

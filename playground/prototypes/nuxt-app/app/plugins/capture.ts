export default defineNuxtPlugin((nuxtApp) => {
  if (import.meta.server) {
    nuxtApp.hook('vue:error', (error, instance) => {
      const event = nuxtApp.ssrContext?.event
      if (event)
        event.context.myBad = { instance, rawStack: (error as Error)?.stack, originalError: error }
    })
    return
  }
  const run = Number(new URL(location.href).searchParams.get('run'))
  const serialize = (value: unknown, depth = 0): Record<string, unknown> => {
    if (depth > 8)
      return { message: 'Cause depth limit reached' }
    const error = value instanceof Error ? value : new Error(String(value))
    return { name: error.name, message: error.message, stack: error.stack, cause: error.cause && serialize(error.cause, depth + 1), errors: error instanceof AggregateError ? error.errors.map(item => serialize(item, depth + 1)) : undefined }
  }
  function capture(error: unknown, instance?: any, kind = 'error', trace?: string) {
    const trail: { label: string, file?: string }[] = []
    let component = instance?.$ ?? instance
    while (component && trail.length < 30) {
      trail.unshift({ label: component.type?.__name ?? component.type?.name ?? 'Anonymous', file: component.type?.__file })
      component = component.parent
    }
    void fetch('/__lab/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: serialize(error), run, kind, trace: trail, vueTrace: trace, route: location.pathname + location.search }) }).catch(() => {})
  }
  nuxtApp.hook('vue:error', (error, instance) => capture(error, instance))
  nuxtApp.vueApp.config.warnHandler = (message, instance, trace) => {
    if (!message.startsWith('Unhandled error during execution'))
      capture(new Error(message), instance, 'warning', trace)
  }
  window.addEventListener('error', event => capture(event.error ?? event.message))
  window.addEventListener('unhandledrejection', event => capture(event.reason))
})

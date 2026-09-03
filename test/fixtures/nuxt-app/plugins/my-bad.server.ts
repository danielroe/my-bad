export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hook('vue:error', (error, instance) => {
    const event = nuxtApp.ssrContext?.event
    if (event) {
      event.context.myBad = { instance, rawStack: (error as Error)?.stack }
    }
  })
})

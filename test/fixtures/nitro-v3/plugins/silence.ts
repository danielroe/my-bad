import { definePlugin } from 'nitro'

export default definePlugin((nitro) => {
  if (nitro.h3) {
    nitro.h3.config.silent = true
  }
})

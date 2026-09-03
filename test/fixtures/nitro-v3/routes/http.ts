import { defineHandler, HTTPError } from 'nitro'

export default defineHandler(() => {
  throw new HTTPError({
    status: 418,
    message: 'I am a teapot',
    data: { brew: 'refused' },
  })
})

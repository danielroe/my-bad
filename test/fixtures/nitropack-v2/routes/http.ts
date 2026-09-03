import { createError, defineEventHandler } from 'h3'

export default defineEventHandler(() => {
  throw createError({ statusCode: 418, statusMessage: 'Teapot', data: { hint: 'x' } })
})

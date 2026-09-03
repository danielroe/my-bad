import { defineEventHandler } from 'h3'
import { loadWidget } from '../utils/widget'

export default defineEventHandler(async () => {
  await new Promise(resolve => setTimeout(resolve, 1))
  return loadWidget('')
})

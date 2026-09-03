import { defineEventHandler } from 'h3'
import { loadWidget } from '../utils/widget'

export default defineEventHandler(() => {
  return loadWidget('')
})

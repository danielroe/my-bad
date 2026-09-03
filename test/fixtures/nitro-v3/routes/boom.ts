import { defineHandler } from 'nitro'
import { detonate } from '../utils/explode'

export default defineHandler(() => {
  return detonate('boom')
})

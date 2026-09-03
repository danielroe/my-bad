import { defineHandler } from 'nitro'
import { detonate } from '../utils/explode'

export default defineHandler(async () => {
  await new Promise(resolve => setTimeout(resolve, 1))
  return detonate('async')
})

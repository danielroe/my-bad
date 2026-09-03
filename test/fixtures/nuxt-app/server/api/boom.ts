import { defineFixtureHandler } from '#fixture/runtime'

export default defineFixtureHandler(() => {
  throw new Error('boom from server route')
})

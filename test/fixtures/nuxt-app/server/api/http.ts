import { defineFixtureHandler, fixtureHTTPError } from '#fixture/runtime'

export default defineFixtureHandler(() => {
  throw fixtureHTTPError(418, 'I am a teapot', { teapot: true })
})

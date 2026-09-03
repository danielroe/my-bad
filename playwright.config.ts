import { defineConfig } from 'playwright/test'

export default defineConfig({
  testDir: './test/visual',
  /**
   * README assets are one canonical file each, committed to the repo, so the
   * default per-platform snapshot suffix is dropped. They are rendered by CI on
   * Linux; regenerating locally will produce font differences.
   */
  snapshotPathTemplate: 'assets/{arg}{ext}',
  use: {
    viewport: { width: 1200, height: 760 },
    deviceScaleFactor: 2,
  },
})

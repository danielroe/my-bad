import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Packs the library, installs the tarball into a scratch project with plain npm,
 * and imports every public entry from there. Catches broken `exports`, missing
 * files, and anything that still references the build-time `virtual:` module.
 */
const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const dir = await mkdtemp(join(tmpdir(), 'my-bad-pack-'))

try {
  const { stdout } = await run('pnpm', ['pack', '--pack-destination', dir], { cwd: root })
  const tarball = (await readdir(dir)).find(file => file.endsWith('.tgz'))
  if (!tarball) {
    throw new Error(`pnpm pack produced no tarball: ${stdout}`)
  }
  const dist = await readdir(join(root, 'dist'), { recursive: true })
  for (const file of dist.filter(file => file.endsWith('.mjs'))) {
    const code = await readFile(join(root, 'dist', file), 'utf8')
    if (/(?:from\s*|import\()['"]\\?0?virtual:my-bad-client/.test(code)) {
      throw new Error(`dist/${file} still references virtual:my-bad-client`)
    }
  }

  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }))
  await run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', join(dir, tarball)], { cwd: dir })
  await writeFile(join(dir, 'check.mjs'), `
import { createReport, renderAnsi, renderOverlay, renderPage, injectOverlay, fsLoader, sourceMapLoader } from 'my-bad'
import { createChannel, openInEditor } from 'my-bad/channel'
import { nuxtPreset, vuePreset, envPreset } from 'my-bad/presets'
import { fileSink } from 'my-bad/sinks'
import { myBad, useMyBad, viteLoader } from 'my-bad/vite'
import { installMyBadClient } from 'my-bad/vite/client'

const report = await createReport(new Error('packed'), { presets: [nuxtPreset()] })
const page = renderPage(report, { channel: '/__my-bad' })
const overlay = renderOverlay(report)
const ansi = renderAnsi(report, { colors: false })
for (const [name, value] of Object.entries({ createChannel, openInEditor, vuePreset, envPreset, fileSink, myBad, useMyBad, viteLoader, installMyBadClient, fsLoader, sourceMapLoader, injectOverlay })) {
  if (typeof value !== 'function') throw new Error(name + ' is not a function')
}
if (!page.includes('packed') || !page.includes('<style>') || !page.includes('mb-root')) throw new Error('page is incomplete')
if (!overlay.startsWith('<my-bad-overlay>')) throw new Error('overlay is incomplete')
if (!ansi.includes('packed')) throw new Error('ansi is incomplete')
console.log('ok', page.length, 'bytes')
`)
  const { stdout: result } = await run(process.execPath, ['check.mjs'], { cwd: dir })
  const types = await readFile(join(dir, 'node_modules/my-bad/package.json'), 'utf8').then(JSON.parse)
  for (const [entry, target] of Object.entries<string>(types.exports)) {
    if (entry !== './package.json' && !target.endsWith('.mjs')) {
      throw new Error(`export ${entry} points at ${target}`)
    }
  }
  console.log(`check-pack: ${result.trim()}`)
}
finally {
  await rm(dir, { recursive: true, force: true })
}

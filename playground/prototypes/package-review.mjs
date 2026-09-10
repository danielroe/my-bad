import { Buffer } from 'node:buffer'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('./public/review/', import.meta.url)
const output = new URL('../out/design-review/', import.meta.url)
await mkdir(output, { recursive: true })
const assets = {}
for (const directory of ['', 'boards/']) {
  for (const name of await readdir(new URL(directory, root))) {
    if (name.endsWith('.png') && !['source-detail-before.png', 'source-detail-after.png', 'stack-before.png', 'stack-after.png'].includes(name)) {
      const path = `${directory}${name}`
      assets[path] = `data:image/png;base64,${(await readFile(new URL(path, root))).toString('base64')}`
    }
  }
}
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'))
const font = (await readFile(new URL('caveat.woff2', root))).toString('base64')
const fontLicense = await readFile(new URL('caveat-license.txt', root), 'utf8')
const css = (await readFile(new URL('review.css', root), 'utf8')).replace('url(\'caveat.woff2\')', `url('data:font/woff2;base64,${font}')`)
const js = await readFile(new URL('review.js', root), 'utf8')
const safeJson = value => JSON.stringify(value).replaceAll('<', '\\u003c')
let html = await readFile(new URL('index.html', root), 'utf8')
html = html.replace('href="caveat-license.txt"', `href="data:text/plain;charset=utf-8,${encodeURIComponent(fontLicense)}" download="caveat-license.txt"`)
html = html.replace('<link rel="stylesheet" href="review.css">', `<style>${css}</style>`)
html = html.replace('<script defer src="review.js"></script>', `<script>window.__reviewAssets=${safeJson(assets)};window.__reviewManifest=${safeJson(manifest)};</script><script>${js.replaceAll('</script', '<\\/script')}</script>`)
html = html.replaceAll(/<a href="\/\?view=[^"]+">[^<]+<\/a>/g, '<span class="local-only">Interactive playground runs locally</span>')
html = html.replace('Test PiP in the <span class="local-only">Interactive playground runs locally</span>;', 'PiP can be tested in the local interactive playground;')
html = html.replace('<a href="manifest.json">Capture metadata</a>', `<a href="data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(manifest, null, 2))}" download="capture-metadata.json">Capture metadata</a>`)
html = html.replace('<a id="share-download" href="my-bad-review.html" download>Share file ↓</a>', '<button id="share-download" type="button">Download review ↓</button>')
const download = `<script>document.querySelector('#share-download').addEventListener('click',()=>{const link=document.createElement('a');const url=URL.createObjectURL(new Blob(['<!doctype html>'+document.documentElement.outerHTML],{type:'text/html'}));link.href=url;link.download='my-bad-review.html';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)});</script>`
html = html.replace('</body>', `${download}</body>`)
await writeFile(new URL('index.html', output), html)
await writeFile(new URL('vercel.json', output), `${JSON.stringify({ framework: null, buildCommand: '', outputDirectory: '.' }, null, 2)}\n`)
await writeFile(new URL('.vercelignore', output), '**\n!index.html\n!vercel.json\n')
await writeFile(new URL('my-bad-review.html', root), html)
await writeFile(new URL('README.txt', output), 'my-bad design review\n\nServe index.html with any static host, or open it in a browser. Screenshots, annotations, technical notes and board downloads are embedded. No server API, local source files, credentials or external fonts are required. The interactive playground is not included.\n')
console.log(`Hosting artifact: ${fileURLToPath(output)} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MB)`)

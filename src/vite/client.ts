/// <reference types="vite/client" />

/**
 * Browser-side companion for the Vite plugin. Mounts the overlay HTML pushed
 * over Vite's HMR channel and removes it when the error clears. A client already
 * listening to the channel renders later errors itself, so only the first is
 * mounted from here.
 */
export function installMyBadClient(hot: ImportMetaHot | undefined = import.meta.hot): void {
  if (!hot) {
    return
  }
  const remove = () => {
    for (const node of document.querySelectorAll('[data-my-bad]')) {
      node.remove()
    }
  }
  hot.on('my-bad:error', ({ html }: { html: string }) => {
    if (window.__MY_BAD_CLIENT__) {
      return
    }
    remove()
    const template = document.createElement('template')
    template.innerHTML = html
    for (const node of [...template.content.children]) {
      if (node.tagName === 'SCRIPT') {
        const script = document.createElement('script')
        for (const attr of node.attributes) {
          script.setAttribute(attr.name, attr.value)
        }
        script.textContent = node.textContent
        script.setAttribute('data-my-bad', '')
        document.body.append(script)
      }
      else {
        node.setAttribute('data-my-bad', '')
        document.body.append(node)
      }
    }
  })
  hot.on('my-bad:clear', remove)
}

type ImportMetaHot = NonNullable<ImportMeta['hot']>

/// <reference types="vite/client" />

export interface MyBadClientOptions {
  /**
   * Milliseconds to wait for a host such as Vite DevTools to take over the
   * badge before mounting the overlay for an error. Default `0`.
   */
  awaitHost?: number
}

/**
 * Browser-side companion for the Vite plugin. Mounts the overlay HTML pushed
 * over Vite's HMR channel and removes it when the error clears. A client already
 * listening to the channel renders later errors itself, so only the first is
 * mounted from here.
 */
export function installMyBadClient(hot: ImportMetaHot | undefined = import.meta.hot, options: MyBadClientOptions = {}): void {
  if (!hot) {
    return
  }
  let latest: unknown
  let wait: Promise<boolean> | undefined
  const remove = () => {
    latest = undefined
    for (const node of document.querySelectorAll('[data-my-bad]')) {
      node.remove()
    }
  }
  const mount = (html: string) => {
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
  }
  hot.on('my-bad:error', (payload: { html: string }) => {
    if (window.__MY_BAD_CLIENT__ || window.__MY_BAD_SOURCE__?.host) {
      return
    }
    if (!options.awaitHost) {
      mount(payload.html)
      return
    }
    latest = payload
    wait ??= hosted(options.awaitHost)
    void wait.then((taken) => {
      if (!taken && latest === payload && !window.__MY_BAD_CLIENT__) {
        mount(payload.html)
      }
    })
  })
  hot.on('my-bad:clear', remove)
}

function hosted(timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeout, false)
    addEventListener('my-bad:host', onHost)
    function onHost() {
      done(true)
    }
    function done(taken: boolean) {
      clearTimeout(timer)
      removeEventListener('my-bad:host', onHost)
      resolve(taken)
    }
  })
}

type ImportMetaHot = NonNullable<ImportMeta['hot']>

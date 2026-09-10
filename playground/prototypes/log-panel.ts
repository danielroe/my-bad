import type { LogEntry } from '../../src/channel/protocol'

export function createLogPanel(copy: (text: string, message: string) => Promise<void>) {
  const panel = document.createElement('section')
  panel.id = 'server-logs'
  panel.className = 'server-logs'
  panel.hidden = true
  panel.setAttribute('aria-labelledby', 'server-logs-title')
  panel.innerHTML = `<header class="logs-header"><h2 id="server-logs-title">Server logs</h2><span class="logs-connection" role="status"></span><div class="logs-actions"><button type="button" data-log-action="copy">Copy logs</button><button type="button" data-log-action="clear">Clear view</button><button type="button" data-log-action="close" aria-label="Close server logs" title="Close server logs"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></div></header>
  <div class="logs-toolbar"><input type="search" aria-label="Filter logs" placeholder="Filter logs…"><select aria-label="Log level"><option value="all">All levels</option><option value="warn">Warnings & errors</option><option value="error">Errors only</option></select><span class="logs-count"></span><button type="button" data-log-action="follow" aria-pressed="true">Follow latest</button></div>
  <div class="logs-scroll" tabindex="0" aria-label="Server log entries"><ol class="logs-list"></ol><p class="logs-empty"></p></div>
  <button type="button" class="logs-latest" data-log-action="latest" hidden>Jump to latest</button>`
  document.body.append(panel)
  const scroll = panel.querySelector<HTMLDivElement>('.logs-scroll')!
  const list = panel.querySelector<HTMLOListElement>('.logs-list')!
  const search = panel.querySelector<HTMLInputElement>('input')!
  const level = panel.querySelector<HTMLSelectElement>('select')!
  const followButton = panel.querySelector<HTMLButtonElement>('[data-log-action="follow"]')!
  const latestButton = panel.querySelector<HTMLButtonElement>('.logs-latest')!
  const empty = panel.querySelector<HTMLElement>('.logs-empty')!
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  let entries: LogEntry[] = []
  let connected = false
  let following = true
  let clearedThrough = -Infinity
  let trigger: HTMLElement | null = null
  let pending = 0
  let previousLast: LogEntry | undefined

  function filtered() {
    const query = search.value.toLocaleLowerCase()
    return entries.filter(entry => entry.timestamp > clearedThrough
      && (level.value === 'all' || (level.value === 'warn' ? ['warn', 'error', 'fatal'] : ['error', 'fatal']).includes(entry.level))
      && entry.text.toLocaleLowerCase().includes(query))
  }

  function follow(latest: boolean) {
    following = latest
    followButton.setAttribute('aria-pressed', String(latest))
    if (latest) {
      pending = 0
      scroll.scrollTop = scroll.scrollHeight
    }
    latestButton.hidden = latest || !list.children.length
    latestButton.textContent = pending ? `${pending} new · Jump to latest` : 'Jump to latest'
  }

  function renderEntries() {
    if (panel.hidden)
      return
    const visible = filtered()
    const anchor = [...list.children].find(row => row.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top)
    const anchorTop = anchor?.getBoundingClientRect().top
    const existing = new Map([...list.children].map(row => [(row as HTMLElement).dataset.key!, row]))
    const occurrences = new Map<string, number>()
    const keep = new Set<string>()
    for (const entry of visible) {
      const fingerprint = JSON.stringify([entry.timestamp, entry.level, entry.text])
      const occurrence = occurrences.get(fingerprint) ?? 0
      occurrences.set(fingerprint, occurrence + 1)
      const key = `${fingerprint}:${occurrence}`
      keep.add(key)
      if (existing.has(key))
        continue
      const row = document.createElement('li')
      row.dataset.key = key
      row.dataset.level = entry.level
      const time = document.createElement('time')
      time.dateTime = new Date(entry.timestamp).toISOString()
      time.title = new Date(entry.timestamp).toLocaleString()
      time.textContent = timeFormat.format(entry.timestamp)
      const severity = document.createElement('span')
      severity.className = 'log-level'
      severity.textContent = entry.level
      const message = document.createElement('pre')
      const lines = entry.text.split('\n')
      if (lines.length > 3) {
        const details = document.createElement('details')
        details.className = 'log-message'
        details.open = !!search.value
        const summary = document.createElement('summary')
        const firstLine = document.createElement('span')
        firstLine.textContent = lines[0] || 'Multiline output'
        const count = document.createElement('span')
        count.className = 'log-line-count'
        count.textContent = `${lines.length - 1} more lines`
        summary.append(firstLine, count)
        message.textContent = lines.slice(1).join('\n')
        details.append(summary, message)
        row.append(time, severity, details)
      }
      else {
        message.className = 'log-message'
        message.textContent = entry.text
        row.append(time, severity, message)
      }
      list.append(row)
    }
    for (const [key, row] of existing) {
      if (!keep.has(key))
        row.remove()
    }
    if (!following && anchor?.isConnected && anchorTop !== undefined)
      scroll.scrollTop += anchor.getBoundingClientRect().top - anchorTop
    panel.querySelector('.logs-count')!.textContent = `${visible.length} entries`
    empty.hidden = visible.length > 0
    empty.textContent = entries.some(entry => entry.timestamp > clearedThrough) ? 'No logs match these filters.' : 'No logs yet. New server output will appear here.'
    panel.querySelector<HTMLButtonElement>('[data-log-action="copy"]')!.disabled = !visible.length
    follow(following)
  }

  function setOpen(open: boolean) {
    if (open === !panel.hidden)
      return
    if (open)
      trigger = document.activeElement as HTMLElement
    panel.hidden = !open
    const page = document.querySelector<HTMLElement>('#app')!
    const offset = open ? window.scrollY : page.scrollTop
    document.documentElement.classList.toggle('logs-open', open)
    document.querySelectorAll('[data-action="logs"]').forEach(button => button.setAttribute('aria-expanded', String(open)))
    if (open) {
      page.scrollTop = offset
      window.scrollTo(0, 0)
      renderEntries()
      search.focus({ preventScroll: true })
    }
    else {
      window.scrollTo(0, offset)
      const restore = trigger?.isConnected ? trigger : document.querySelector<HTMLElement>('[data-action="logs"]')
      restore?.focus({ preventScroll: true })
    }
  }

  panel.addEventListener('click', async (event) => {
    const action = (event.target as Element).closest<HTMLElement>('[data-log-action]')?.dataset.logAction
    if (action === 'close') {
      setOpen(false)
    }
    else if (action === 'follow' || action === 'latest') {
      follow(action === 'latest' || !following)
    }
    else if (action === 'clear') {
      clearedThrough = Math.max(clearedThrough, ...entries.map(entry => entry.timestamp))
      pending = 0
      renderEntries()
    }
    else if (action === 'copy') {
      await copy(filtered().map(entry => `${new Date(entry.timestamp).toISOString()} [${entry.level}] ${entry.text}`).join('\n'), 'Visible logs copied')
    }
  })
  panel.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    }
  })
  scroll.addEventListener('scroll', () => follow(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 16))
  function applyFilters() {
    list.replaceChildren()
    renderEntries()
    scroll.scrollTop = following ? scroll.scrollHeight : 0
  }
  search.addEventListener('input', applyFilters)
  level.addEventListener('change', applyFilters)

  return {
    get isOpen() { return !panel.hidden },
    toggle: () => setOpen(!!panel.hidden),
    close: () => setOpen(false),
    update(next: LogEntry[], live: boolean) {
      let lastIndex = -1
      if (previousLast) {
        for (let index = next.length - 1; index >= 0; index--) {
          const entry = next[index]!
          if (entry.timestamp === previousLast.timestamp && entry.level === previousLast.level && entry.text === previousLast.text) {
            lastIndex = index
            break
          }
        }
      }
      if (!following && previousLast)
        pending += lastIndex === -1 ? next.length : next.length - lastIndex - 1
      previousLast = next.at(-1)
      entries = next
      connected = live
      panel.querySelector('.logs-connection')!.textContent = connected ? 'Live' : 'Disconnected'
      panel.querySelector('.logs-connection')!.setAttribute('data-connected', String(connected))
      renderEntries()
    },
  }
}

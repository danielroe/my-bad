const boards = [
  {
    id: 'overview',
    label: 'FIRST LOOK',
    title: 'Lead with what actually failed.',
    intro: 'Put the failure message and an actionable source excerpt before the diagnostic details.',
    before: 'The error type is the heading. The message, component ancestry and stack follow below it.',
    after: 'The message becomes the heading. Type and environment stay secondary, with one source excerpt visible immediately.',
    technical: [
      [
        'Keep the failure actionable',
        'Show an application frame with captured source when possible. Native frames and frames without source remain accessible in the call stack.',
      ],
    ],
  },
  {
    id: 'source-detail',
  },
  {
    id: 'stack',
    label: 'CALL STACK · TWO PROPOSALS',
    title: 'Inspect one frame, or read the stack together.',
    intro: 'Both keep the error and its main excerpt on the same page. The decision is how much code a single Call stack action should reveal.',
    before: 'Focus opens a compact frame list. Select a frame to inspect its code beneath the row; the main excerpt stays in place.',
    after: 'Stack opens all application excerpts in captured order. Framework runs stay compact until requested, at their original positions.',
    technical: [
      [
        'Preserve execution order',
        'Framework calls stay in their original positions. Collapsed ranges show where calls are omitted, so two visible application frames do not appear to be direct callers when they are not.',
      ],
      [
        'Balance scanning and scrolling',
        'Focus exposes less code at once but needs more selections. Stack reveals every application excerpt with one action, at the cost of a longer page.',
      ],
    ],
  },
  {
    id: 'causes',
    label: 'FOLLOW A CAUSE · RETURN TO THE REPORT',
    title: 'Follow the cause. Keep a way back.',
    intro: 'For an error with one direct cause, the message itself becomes the navigation. Follow “Caused by” to inspect the underlying failure; “Back to” returns to the reported error.',
    before: 'Each cause appears as another report below the previous one, with its own source and frames.',
    after: 'Start with the reported failure and its source. “Caused by” names the underlying error and opens it in the same view.',
    technical: [
      [
        'Scope of this flow',
        'A report with one direct cause uses the message link and named return. Longer chains and AggregateError branches still need the navigator. Copy and source controls act on the report being inspected.',
      ],
    ],
  },
  {
    id: 'related',
    label: 'SEVERAL RELATED ERRORS',
    title: 'One failed import. Three errors to inspect.',
    intro: 'An import can fail for several independent reasons. Keep the overall failure visible, then let the reader choose the row they want to investigate.',
    before: 'The current library lists the individual errors after the import’s source and stack. Reaching later rows means scrolling through the preceding reports.',
    after: 'The picker puts all three messages together. Choose a row to see its error and source in the same view.',
    technical: [
      [
        'A group, not a chain',
        'These errors belong to the same import; one does not cause the next. Selecting a row changes the report being inspected. It does not fix or dismiss any of the other errors.',
      ],
    ],
  },
  {
    id: 'copy',
    label: 'COPY & SHARE',
    title: 'Make copying the primary action.',
    intro: 'The library already offers a copy menu. The proposed split button makes the default copy explicit and keeps alternative formats beside it.',
    before: 'An icon opens the library’s copy formats, including message-only, raw stack and JSON.',
    after: 'Copy error works directly. The adjacent dropdown offers Markdown, an agent prompt and structured JSON while the error remains visible.',
    technical: [
      [
        'Keep the format choices',
        'The proposed primary action copies the report directly. Retain the library’s message-only and raw-stack formats alongside Markdown and JSON when bringing this into the default screen.',
      ],
    ],
  },
  {
    id: 'logs',
    label: 'SERVER OUTPUT',
    title: 'Find the relevant output without losing your place.',
    intro: 'The baseline already has a log drawer and severity filtering. Search and deliberate follow behavior help when the stream contains more than the current failure.',
    before: 'A bottom drawer shows timestamp, severity and message, with severity filtering and a clear action.',
    after: 'A docked panel adds search, filtered copying and follow controls. Long messages expand inline, and Logs reflects the panel’s open state.',
    technical: [
      [
        'Keep control of incoming output',
        'Following pauses when the reader scrolls away. Returning to the latest entries resumes it. Clear view affects this viewer; it does not delete server history.',
      ],
    ],
  },
]

const asset = path => window.__reviewAssets?.[path] ?? path
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
let stackComparison = 'current-stack'
let stackState = 'open'
let causeInspected = false
let relatedState = 'menu'
let relatedRow = '2'
const relatedRows = ['Row 2: employee name is missing', 'Row 4: invalid email address “invalid-email”', 'Row 6: department is missing']
const stackLabels = { current: 'Current my-bad', focus: 'Focus', stack: 'Stack' }
const stackDetails = { current: 'Existing library', focus: 'Inspect one frame', stack: 'Read application frames together' }
const stackCaptions = { current: 'The current library shows the stack immediately, with the first excerpt open. Callers expand individually, and consecutive framework frames are grouped.', focus: 'Focus opens a compact frame list. Select a frame to inspect its code beneath the row; the main excerpt stays in place.', stack: 'Stack opens all application excerpts in captured order. Framework runs stay compact until requested, at their original positions.' }
function renderPair(board, state = 'open') {
  const isStack = board.id === 'stack'
  return ['before', 'after'].map((side) => {
    const version = stackComparison.split('-')[side === 'before' ? 0 : 1]
    const causeAfter = board.id === 'causes' && side === 'after'
    const relatedAfter = board.id === 'related' && side === 'after'
    const label = isStack ? stackLabels[version] : side === 'before' ? 'Current my-bad' : causeAfter || relatedAfter ? 'Stack prototype' : 'Focus prototype'
    const caption = relatedAfter ? relatedCaption() : causeAfter && causeInspected ? 'The cause’s message, source and stack take over. “Back to: Could not load employees” restores the reported error.' : isStack ? stackCaptions[version] : board[side]
    const path = relatedAfter ? relatedState === 'row' ? `related-row-${relatedRow}.png` : relatedState === 'menu' ? 'related-menu.png' : 'related-after.png' : causeAfter && causeInspected ? 'causes-inspected.png' : isStack ? `stack-${version}-${state}.png` : `${board.id}-${side}.png`
    return `<figure><figcaption><span class="side-label">${isStack ? label : side === 'before' ? 'Before' : 'Proposed'}</span><span>${isStack ? stackDetails[version] : label}</span></figcaption><button class="capture" data-image="${path}" data-caption="${esc(board.title)} — ${label}${isStack ? ` · ${state}` : ''}" aria-label="Enlarge ${label} screenshot: ${esc(board.title)}"><img src="${asset(path)}" alt="${esc(caption)}" loading="lazy"></button><p class="caption"${causeAfter || relatedAfter ? ' aria-live="polite"' : ''}>${caption}</p>${causeAfter ? `<div class="cause-walkthrough"><span>${causeInspected ? 'Inspecting the cause' : 'Try the cause link'}</span><button type="button" data-cause-step>${causeInspected ? '← Back to reported error' : 'Follow cause →'}</button></div>` : relatedAfter ? renderRelatedControls() : ''}</figure>`
  }).join('')
}
function relatedCaption() {
  if (relatedState === 'summary')
    return 'The summary describes the failed import. “3 related errors” opens the individual messages.'
  if (relatedState === 'menu')
    return 'Compare the row messages before opening one. The reported error remains the first choice.'
  return 'The selected row’s message, source and stack are shown. “Reported as” keeps the import in view; “Reported error” returns to its summary.'
}
function renderRelatedControls() {
  return `<div class="related-steps" role="group" aria-label="Explore related errors">${[['summary', 'Import summary'], ['menu', 'Choose a row'], ['row', 'Inspect row']].map(([state, label]) => `<button type="button" data-related-state="${state}" aria-pressed="${relatedState === state}">${label}</button>`).join('')}</div>${relatedState === 'row' ? `<label class="related-row-select">Inspect <select data-related-row>${relatedRows.map((label, i) => `<option value="${i + 1}" ${relatedRow === String(i + 1) ? 'selected' : ''}>${label}</option>`).join('')}</select></label>` : ''}`
}
function updateRelated() {
  const pair = document.querySelector('#related .comparison')
  pair.innerHTML = renderPair(boards.find(board => board.id === 'related'))
  decorateCaptures(pair)
  pair.querySelector(`[data-related-state="${relatedState}"]`).focus({ preventScroll: true })
}
function renderSourceChoice() {
  const cases = [
    { name: 'precise', label: 'Caret retained', detail: 'Existing behavior', caption: 'A reported column points to the property access. Keep the caret beneath the code, just as in the current library.' },
    { name: 'compact', label: 'Line highlight only', detail: 'Explicit error wrapper', caption: 'This catch block adds a save-failure message and preserves the cause. Highlighting the throw identifies the wrapper; an arrow into its indentation would add no useful precision.' },
  ]
  return `<section id="source-detail" class="board source-choice"><header class="board-header"><p class="eyebrow">SOURCE DETAILS</p><h2>Keep the caret when it adds precision.</h2><p>A property access benefits from an exact pointer. An explicit error wrapper can be clear from the highlighted line alone.</p><a class="export-board" href="${asset('boards/source-detail.png')}" download="source-detail.png">Download annotated board ↗</a></header><div class="comparison">${cases.map(item => `<figure><figcaption><span class="side-label">${item.label}</span><span>${item.detail}</span></figcaption><button class="capture" data-image="source-detail-${item.name}.png" data-caption="${item.label} — ${item.detail}" aria-label="Enlarge ${item.label.toLowerCase()} example"><img src="${asset(`source-detail-${item.name}.png`)}" alt="${item.caption}" loading="lazy"></button><p class="caption">${item.caption}</p></figure>`).join('')}</div>${renderSourceControls()}</section>`
}

function renderSourceControls() {
  return `<div class="source-controls"><h3>Read more of the surrounding code.</h3><p class="section-intro">A short excerpt keeps the failure in view. Expand it when you need to understand the surrounding function.</p><div class="comparison">${[
    { path: 'controls-default.png', label: 'Initial excerpt', caption: 'Three lines on either side of the failure. Source / Compiled stays directly accessible in the header.' },
    { path: 'controls-expanded.png', label: 'More context', caption: 'Reveal the rest of the captured excerpt in place. The same control collapses it again.' },
  ].map(item => `<figure><figcaption><span class="side-label">${item.label}</span></figcaption><button class="capture" data-image="${item.path}" data-caption="${item.label}" aria-label="Enlarge ${item.label.toLowerCase()}"><img src="${asset(item.path)}" alt="${item.caption}" loading="lazy"></button><p class="caption">${item.caption}</p></figure>`).join('')}</div></div>`
}

// Coordinates are in the original capture's pixel space; image and ink scale together.
// Curved leaders and brackets follow AnnotationKit's standalone SVG approach.
function captureNotes(path, height) {
  const note = (text, x, y, d, dark = false, mark = '') => ({ text: text.split('|'), x, y, d, dark, mark })
  if (path.startsWith('related-row-')) {
    return [
      note('Return to the import summary.', 310, -42, 'M297 -34 C69 -47 91 164 164 199'),
      note('The source now belongs|to the selected row.', 570, 730, 'M555 711 C82 716 48 393 150 285', true),
    ]
  }
  const fixed = {
    'related-before.png': [
      note('The row errors start|after the import’s stack.', 545, 835, 'M530 811 Q361 740 222 761', true),
    ],
    'related-after.png': [
      note('Open all three messages here.', 350, -42, 'M334 -35 C73 -57 95 164 284 199'),
      note('Start with the whole import.', 475, 733, 'M464 718 C87 715 65 370 149 294', true),
    ],
    'related-menu.png': [
      note('Choose by the row’s message.', 345, -42, 'M327 -34 C49 -31 79 305 302 320'),
      note('Three separate validation errors,|grouped under one import.', 682, 715, 'M665 692 C642 639 649 530 644 456', true, 'M641 290 l13 0 0 163 -13 0'),
    ],

    'controls-default.png': [
      note('Expand the surrounding code.', 165, -40, 'M523 -47 C766 -90 894 -51 897 18'),
    ],
    'controls-expanded.png': [
      note('Same file. A wider excerpt.', 125, -40, 'M110 -34 C38 -28 29 48 55 70'),
      note('Collapse it when you are done.', 345, 409, 'M798 391 C974 385 977 59 906 24'),
    ],
    'overview-before.png': [
      note('The type gets the headline…', 460, -42, 'M450 -48 C335 -62 95 -30 102 100 Q104 155 157 165'),
      note('…but the useful message|is down here.', 680, 267, 'M670 256 Q638 244 635 220', true),
    ],
    'overview-after.png': [
      note('The message becomes|the starting point.', 210, -57, 'M195 -38 C106 -27 104 100 150 140'),
      note('Open Call stack|when you need the callers.', 560, 724, 'M542 709 C309 730 97 637 128 522 Q138 485 165 477', true),
    ],
    'causes-before.png': [
      note('The wrapper is first.', 385, -45, 'M370 -51 C110 -90 101 158 157 204'),
      note('The cause continues|below this viewport.', 500, 970, 'M486 951 Q371 927 362 879'),
    ],
    'causes-after.png': [
      note('The cause’s message is the link.', 120, -42, 'M110 -33 C21 38 106 172 220 190'),
      note('Inspect the cause here,|without a breadcrumb trail.', 510, 730, 'M975 723 C1250 713 1243 259 1155 208 C1045 165 635 179 409 190', true),
    ],
    'causes-inspected.png': [
      note('Return to the named report.', 120, -42, 'M110 -33 C21 38 91 171 177 190'),
      note('The cause now has|the heading and source.', 535, 731, 'M520 715 C99 742 75 467 151 365', true),
    ],
    'copy-before.png': [
      note('Even the default copy|starts with this menu.', 410, -61, 'M790 -37 C992 -82 1139 -26 1191 25'),
    ],
    'copy-after.png': [
      note('A direct action…', 600, -45, 'M847 -48 C949 -59 1024 -21 1033 88'),
      note('…with other formats|right beside it.', 657, 705, 'M1010 670 C1250 620 1232 190 1128 173', true, 'M1132 130 l15 -2 0 97 -15 0'),
    ],
    'logs-before.png': [
      note('Severity filtering|already exists.', 600, -62, 'M913 -34 C1270 -63 1268 436 1132 548'),
    ],
    'logs-after.png': [
      note('Search within this output.', 65, 980, 'M54 958 C-21 923 4 688 32 631'),
      note('Resume the stream|when you are ready.', 815, 987, 'M1170 962 C1277 920 1275 704 1240 634'),
      note('Long entries expand in place.', 348, 463, 'M336 467 C55 442 65 693 149 784', true),
    ],
    'source-detail-precise.png': [
      note('Which property? This one.', 285, 156, 'M282 138 Q204 132 200 53'),
    ],
    'source-detail-compact.png': [
      note('The throw is clear on its own.', 365, -39, 'M346 -35 Q213 -42 164 30'),
      note('No extra caret row.', 70, 151, 'M65 130 Q22 123 24 47', false, 'M13 23 l-8 0 0 23 8 0'),
    ],
  }
  if (fixed[path])
    return fixed[path]
  if (!path.startsWith('stack-'))
    return []
  const [, version, state] = path.replace('.png', '').split('-')
  if (version === 'current') {
    const frameY = state === 'framework' ? 979 : 654
    return [note('Frames are visible from the start.', 160, -44, 'M145 -36 C31 41 84 273 178 326'), note(state === 'framework' ? 'Dependency groups expand|where they occur.' : 'Each caller opens individually.', 450, height + 76, `M438 ${height + 59} C66 ${height + 25} 74 ${frameY + 69} 178 ${frameY}`)]
  }
  const toggleY = version === 'stack' ? 455 : 477
  const targetY = state === 'closed' ? 324 : version === 'stack' ? toggleY : 557
  const targetX = state === 'closed' ? 179 : version === 'stack' ? 179 : 174
  const label = state === 'closed' ? 'One excerpt to begin with.' : version === 'stack' ? 'One click reveals the application code.' : 'Choose a caller to open its code.'
  const notes = [note(label, 165, -44, `M152 -36 C17 12 65 ${targetY - 37} ${targetX} ${targetY}`)]
  if (state === 'closed') {
    notes.push(note('Open Call stack for the callers.', 580, 726, `M567 713 C268 736 111 ${toggleY + 94} ${version === 'stack' ? 179 : 167} ${toggleY}`, true))
  }
  else {
    const callerY = version === 'stack' ? (state === 'framework' ? 782 : 746) : 862
    notes.push(note(state === 'framework' ? 'Framework calls keep|their place in the stack.' : version === 'stack' ? 'Hidden calls still have a place|between these excerpts.' : 'The next caller stays compact.', 468, height + 80, `M453 ${height + 64} C65 ${height + 37} 77 ${callerY + 93} 174 ${callerY}`))
  }
  return notes
}
function decorateCaptures(root) {
  for (const button of root.querySelectorAll('.capture')) {
    if (button.parentElement.classList.contains('annotation-scene'))
      continue
    const img = button.querySelector('img')
    const draw = () => {
      if (button.parentElement.classList.contains('annotation-scene'))
        return
      const w = img.naturalWidth
      const h = img.naturalHeight
      if (!w)
        return
      const notes = captureNotes(button.dataset.image, h)
      if (!notes.length)
        return
      const scene = document.createElement('div')
      scene.className = 'annotation-scene'
      scene.style.paddingTop = `${100 / w * 100}%`
      scene.style.paddingBottom = `${130 / w * 100}%`
      button.before(scene)
      scene.append(button)
      const id = `arrow-${button.dataset.image.replaceAll('.', '-')}`
      const svg = `<svg class="frame-ink annotation" viewBox="0 -100 ${w} ${h + 230}" aria-hidden="true"><defs><marker id="${id}" viewBox="0 0 18 18" refX="15" refY="9" markerWidth="18" markerHeight="18" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M3 2 Q10 8 15 9 Q9 10 3 16"/></marker></defs>${notes.map(n => `<g class="${n.dark ? 'on-image' : ''}"><path class="ink-leader" d="${n.d}" marker-end="url(#${id})"/>${n.mark ? `<path d="${n.mark}"/>` : ''}<text x="${n.x}" y="${n.y}">${n.text.map((line, i) => `<tspan x="${n.x}" dy="${i ? 38 : 0}">${esc(line)}</tspan>`).join('')}</text></g>`).join('')}</svg>`
      scene.insertAdjacentHTML('beforeend', svg)
      if (button.dataset.image === 'causes-after.png' || button.dataset.image === 'causes-inspected.png') {
        const back = button.dataset.image === 'causes-inspected.png'
        scene.insertAdjacentHTML('beforeend', `<button class="cause-hotspot" type="button" data-cause-step style="left:${(back ? 160 : 228) / w * 100}%;top:${(176 + 100) / (h + 230) * 100}%;width:${(back ? 230 : 176) / w * 100}%;height:${29 / (h + 230) * 100}%" aria-label="${back ? 'Back to: Could not load employees' : 'Caused by: Employee 1 is missing a name'}"></button>`)
      }
      if (button.dataset.image.startsWith('related-') && button.dataset.image !== 'related-before.png') {
        const hotspots = [{ x: 160, y: 184, width: 116, height: 32, state: 'summary', label: 'Return to reported import error' }, { x: 283, y: 184, width: 150, height: 32, state: 'menu', label: 'Choose a related error' }]
        if (button.dataset.image === 'related-menu.png') {
          hotspots.push({ x: 290, y: 227, width: 334, height: 54, state: 'summary', label: 'Reported import error' })
          relatedRows.forEach((label, index) => hotspots.push({ x: 290, y: 285 + index * 58, width: 334, height: 54, state: 'row', row: index + 1, label }))
        }
        scene.insertAdjacentHTML('beforeend', hotspots.map(hotspot => `<button class="cause-hotspot" type="button" data-related-state="${hotspot.state}" ${hotspot.row ? `data-row="${hotspot.row}"` : ''} style="left:${hotspot.x / w * 100}%;top:${(hotspot.y + 100) / (h + 230) * 100}%;width:${hotspot.width / w * 100}%;height:${hotspot.height / (h + 230) * 100}%" aria-label="${esc(hotspot.label)}"></button>`).join(''))
      }
      scene.insertAdjacentHTML('afterend', `<ul class="mobile-ink annotation">${notes.map(n => `<li>${n.text.map(esc).join(' ')}</li>`).join('')}</ul>`)
    }
    if (img.complete)
      draw()
    else img.addEventListener('load', draw, { once: true })
  }
}
document.querySelector('#boards').innerHTML = boards.map(board => board.id === 'source-detail' ? renderSourceChoice() : `<section id="${board.id}" class="board"><header class="board-header"><p class="eyebrow">${board.label}</p><h2>${board.title}</h2><p>${board.intro}</p><a class="export-board" href="${asset(`boards/${board.id}.png`)}" download="${board.id}.png">Download annotated board ↗</a></header>${board.id === 'stack' ? `<label class="stack-comparison">Compare <select id="stack-comparison"><option value="current-stack">Current my-bad / Stack</option><option value="current-focus">Current my-bad / Focus</option><option value="focus-stack">Focus / Stack</option></select></label><div class="stack-states" role="group" aria-label="Compare Call Stack states"><button data-stack-state="closed" aria-pressed="false">Initial view</button><button data-stack-state="open" aria-pressed="true">Inspect callers</button><button data-stack-state="framework" aria-pressed="false">Include framework frames</button></div><p class="state-caption" aria-live="polite">Current my-bad: expand showProfile. Stack: open Call stack to reveal all application excerpts.</p>` : ''}<div class="comparison">${renderPair(board)}</div>${board.id === 'stack' ? '<div class="annotations annotation"></div>' : ''}<details class="technical"><summary>Design considerations</summary><div class="technical-content">${board.technical.map(([title, text]) => `<article><h3>${title}</h3><p>${text}</p></article>`).join('')}</div></details></section>`).join('')
function updateStackComparison() {
  document.querySelectorAll('[data-stack-state]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.stackState === stackState)))
  document.querySelector('#stack .comparison').innerHTML = renderPair(boards.find(board => board.id === 'stack'), stackState)
  decorateCaptures(document.querySelector('#stack'))
  const descriptions = {
    current: { closed: 'The stack is visible immediately; its first excerpt is open.', open: 'Expand showProfile to inspect the caller.', framework: 'Expand the dependency groups between application frames.' },
    focus: { closed: 'The main excerpt is visible; Call stack is collapsed.', open: 'Open Call stack, then select showProfile.', framework: 'Enable Show framework frames to expose the individual rows.' },
    stack: { closed: 'The main excerpt is visible; Call stack is collapsed.', open: 'Open Call stack to reveal every application excerpt.', framework: 'Enable Show framework frames to expose the grouped runs in place.' },
  }
  document.querySelector('.state-caption').textContent = stackComparison.split('-').map(version => `${stackLabels[version]}: ${descriptions[version][stackState]}`).join(' ')
  const tradeoffs = {
    current: ['Stack visible immediately', 'The frame list is available from the start, and each source excerpt expands within it. More diagnostic structure occupies the initial screen.'],
    focus: ['Less code to scan', 'Inspect one caller at a time while keeping the main excerpt in place. Reading several callers requires selecting them in turn.'],
    stack: ['Fewer disclosure steps', 'Read every application excerpt after one expansion. Long stacks require more scrolling.'],
  }
  document.querySelector('#stack .annotations').innerHTML = stackComparison.split('-').map((version, index) => `<p><span class="note-number">${index + 1}</span><span><strong>${stackLabels[version]} · ${tradeoffs[version][0]}</strong>${tradeoffs[version][1]}</span></p>`).join('')
}
document.querySelector('#stack-comparison').addEventListener('change', (event) => {
  stackComparison = event.target.value
  updateStackComparison()
})
document.querySelectorAll('[data-stack-state]').forEach(button => button.addEventListener('click', () => {
  stackState = button.dataset.stackState
  updateStackComparison()
}))
updateStackComparison()
decorateCaptures(document.querySelector('#boards'))
const viewer = document.querySelector('#image-viewer')
document.querySelector('#boards').addEventListener('click', (event) => {
  const relatedButton = event.target.closest('[data-related-state]')
  if (relatedButton) {
    relatedState = relatedButton.dataset.relatedState
    if (relatedButton.dataset.row)
      relatedRow = relatedButton.dataset.row
    updateRelated()
    return
  }
  if (event.target.closest('[data-cause-step]')) {
    causeInspected = !causeInspected
    const pair = document.querySelector('#causes .comparison')
    pair.innerHTML = renderPair(boards.find(board => board.id === 'causes'))
    decorateCaptures(pair)
    pair.querySelector('.cause-walkthrough button').focus({ preventScroll: true })
    return
  }
  const button = event.target.closest('[data-image]')
  if (!button)
    return
  viewer.querySelector('img').src = asset(button.dataset.image)
  viewer.querySelector('img').alt = button.dataset.caption
  viewer.querySelector('p').textContent = button.dataset.caption
  viewer.showModal()
})
document.querySelector('#boards').addEventListener('change', (event) => {
  if (!event.target.matches('[data-related-row]'))
    return
  relatedRow = event.target.value
  updateRelated()
  document.querySelector('[data-related-row]').focus({ preventScroll: true })
})
viewer.addEventListener('click', (event) => {
  if (event.target === viewer)
    viewer.close()
})
document.querySelector('#annotations').addEventListener('change', event => document.body.classList.toggle('hide-annotations', !event.target.checked))
document.querySelector('#print').addEventListener('click', () => window.print())
let previouslyOpen = []
window.addEventListener('beforeprint', () => {
  previouslyOpen = [...document.querySelectorAll('details')].map(details => details.open)
  document.querySelectorAll('details').forEach(details => details.open = true)
})
window.addEventListener('afterprint', () => document.querySelectorAll('details').forEach((details, i) => details.open = previouslyOpen[i]))
const manifest = window.__reviewManifest ? Promise.resolve(window.__reviewManifest) : fetch('manifest.json').then(response => response.json())
manifest.then((meta) => {
  document.querySelector('#capture-info').textContent = `Captured ${new Date(meta.capturedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}. Current library and working prototypes use the same captured reports.`
}).catch(() => {})

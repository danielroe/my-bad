export function createPagePreview(showPage: () => void, showError: () => void) {
  const preview = document.createElement('div')
  preview.className = 'page-preview'
  preview.hidden = true
  preview.innerHTML = `<button type="button" class="page-preview-open" aria-label="Show page behind this error"><span>Show page</span></button><button type="button" class="page-preview-close" aria-label="Hide page preview" title="Hide page preview"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button>`
  const restore = document.createElement('button')
  restore.type = 'button'
  restore.className = 'error-preview'
  restore.hidden = true
  restore.innerHTML = '<span class="error-preview-heading">Show error <span aria-hidden="true">↗</span></span><span class="error-preview-message"></span>'
  document.body.append(preview, restore)
  let dismissed = false
  let reportId: string | undefined
  let visible = false

  function resize() {
    const scale = Math.min(220 / window.innerWidth, 0.4, 160 / window.innerHeight)
    const style = document.documentElement.style
    style.setProperty('--page-preview-scale', String(scale))
    style.setProperty('--page-preview-width', `${window.innerWidth * scale}px`)
    style.setProperty('--page-preview-height', `${window.innerHeight * scale}px`)
  }
  function updateVisibility() {
    preview.hidden = !visible || dismissed
    document.documentElement.classList.toggle('page-preview-visible', !preview.hidden)
  }
  preview.querySelector('.page-preview-open')!.addEventListener('click', showPage)
  preview.querySelector('.page-preview-close')!.addEventListener('click', () => {
    dismissed = true
    updateVisibility()
    document.getElementById('error-content')?.focus({ preventScroll: true })
  })
  restore.addEventListener('click', showError)
  window.addEventListener('resize', resize)
  resize()
  return {
    update(id: string | undefined, message: string, screenVisible: boolean) {
      if (reportId !== id)
        dismissed = false
      reportId = id
      visible = screenVisible
      restore.hidden = !id || screenVisible
      restore.querySelector('.error-preview-message')!.textContent = message
      updateVisibility()
    },
  }
}

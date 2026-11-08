const RESIZE_EDGES = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']

/**
 * Edit-mode chrome shared by every overlay: dashed frame (native drag area),
 * name + size label and 8 resize handles. Also applies lock state and opacity.
 */
export function mountOverlayFrame({ title }) {
  const frame = document.createElement('div')
  frame.className = 'edit-frame'

  const label = document.createElement('div')
  label.className = 'edit-label'
  frame.append(label)

  for (const edge of RESIZE_EDGES) frame.append(createResizeHandle(edge))
  document.body.append(frame)

  return {
    update(settings, overlay) {
      document.body.classList.toggle('is-locked', settings.locked)
      document.documentElement.style.setProperty('--content-opacity', String(overlay.opacity))
      label.textContent = `${title} · ${overlay.bounds.width} × ${overlay.bounds.height}`
    }
  }
}

function createResizeHandle(edge) {
  const handle = document.createElement('div')
  handle.className = `resize-handle resize-${edge}`

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || document.body.classList.contains('is-locked')) return
    event.preventDefault()
    // Capture guarantees we get the release even if the cursor leaves the window.
    handle.setPointerCapture(event.pointerId)
    window.overlayApi.beginResize(edge)
  })
  handle.addEventListener('lostpointercapture', () => window.overlayApi.endResize())

  return handle
}

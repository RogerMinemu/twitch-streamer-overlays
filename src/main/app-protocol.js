const fs = require('node:fs/promises')
const path = require('node:path')
const { protocol } = require('electron')

const SCHEME = 'app'
const HOST = 'overlay'
const APP_ORIGIN = `${SCHEME}://${HOST}`
const RENDERER_ROOT = path.join(__dirname, '..', 'renderer')

// Explicit MIME types: Windows registry overrides can make ".js" resolve to text/plain,
// which silently breaks <script type="module">.
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
}

/** Must run BEFORE app is ready. A privileged scheme is a secure context, so getUserMedia works. */
function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ])
}

/** Serves src/renderer as app://overlay/... and refuses anything outside that folder. */
function handleAppProtocol() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host !== HOST) return notFound()

    const filePath = path.resolve(RENDERER_ROOT, `.${decodeURIComponent(url.pathname)}`)
    const relative = path.relative(RENDERER_ROOT, filePath)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return notFound()

    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()]
    if (!contentType) return notFound()

    try {
      const body = await fs.readFile(filePath)
      return new Response(body, { headers: { 'content-type': contentType } })
    } catch {
      return notFound()
    }
  })
}

function pageUrl(page) {
  return `${APP_ORIGIN}/${page}/index.html`
}

function notFound() {
  return new Response('Not found', { status: 404 })
}

module.exports = { APP_ORIGIN, registerAppScheme, handleAppProtocol, pageUrl }

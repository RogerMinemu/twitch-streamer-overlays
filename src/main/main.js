const path = require('node:path')
const { app, screen, session } = require('electron')
const { APP_ORIGIN, registerAppScheme, handleAppProtocol } = require('./app-protocol')
const { SettingsStore, createDefaults } = require('./settings-store')
const { OverlayController } = require('./overlay-controller')
const { createTray } = require('./tray')

/** @type {OverlayController | null} */
let controller = null
/** @type {import('electron').Tray | null} */
let tray = null // module-level reference so the tray icon isn't garbage-collected

registerAppScheme()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => controller?.showPanel())
  app.whenReady().then(bootstrap)
}

function bootstrap() {
  handleAppProtocol()
  configurePermissions()

  const store = new SettingsStore(
    path.join(app.getPath('userData'), 'settings.json'),
    createDefaults(screen.getPrimaryDisplay().workArea)
  )
  controller = new OverlayController({
    store,
    preloadPath: path.join(__dirname, '..', 'preload', 'preload.js')
  })
  controller.start()
  tray = createTray(controller)
}

/** Only our own pages may use the camera, and only video (never the microphone). */
function configurePermissions() {
  const { defaultSession } = session

  defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const fromApp = details.requestingUrl?.startsWith(APP_ORIGIN) ?? false
    const videoOnly = permission === 'media' && (details.mediaTypes ?? []).every((type) => type === 'video')
    callback(fromApp && videoOnly)
  })

  defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return permission === 'media' && requestingOrigin.startsWith(APP_ORIGIN)
  })
}

// Hardening: our windows never navigate away or open popups.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})

// Closing the panel must NOT quit: the app lives in the tray while you play.
app.on('window-all-closed', () => {})
app.on('before-quit', () => controller?.prepareQuit())
app.on('will-quit', () => {
  controller?.dispose()
  tray?.destroy()
})

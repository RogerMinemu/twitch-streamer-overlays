const path = require('node:path')
const { app, BrowserWindow, globalShortcut, ipcMain, screen, shell } = require('electron')
const { APP_ORIGIN, pageUrl } = require('./app-protocol')
const { OVERLAY_IDS, MIN_OVERLAY_SIZE, createDefaults } = require('./settings-store')
const { writeGreenScreenImage } = require('./green-screen-image')
const { NativeCamera } = require('./native-camera')
const { ensureCaptureHelper } = require('./native-capture-helper')

const OVERLAY_TITLES = { camera: 'Overlay · Cámara', chat: 'Overlay · Chat' }
const BROADCAST_DELAY_MS = 50
const RESIZE_TICK_MS = 16
const MIN_VISIBLE_PX = 40
const RESIZE_EDGES = new Set(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'])
const CHAT_STATES = new Set(['idle', 'connecting', 'connected', 'reconnecting', 'error'])
const FALLBACK_HOTKEYS = ['CommandOrControl+Alt+Shift+L', 'CommandOrControl+Alt+Shift+O', 'CommandOrControl+Alt+F12']
const FRAME_ACK_TIMEOUT_MS = 1000
const DEFAULT_NATIVE_DEVICE = 'NVIDIA Broadcast'

/**
 * Single source of truth. Renderers never own state: they send patches here,
 * this class validates them, applies them to the real windows and broadcasts the result.
 */
class OverlayController {
  constructor({ store, preloadPath }) {
    this.store = store
    this.preloadPath = preloadPath
    this.overlays = new Map()
    this.panel = null
    this.quitting = false
    this.resizeSession = null
    this.broadcastTimer = null
    this.changeListeners = new Set()
    this.runtime = {
      cameraDevices: [],
      chatStatus: { state: 'idle', channel: '', detail: '' },
      nativeCamera: { state: 'idle', detail: '' },
      hotkey: { accelerator: store.get().hotkeys.toggleLock, configured: store.get().hotkeys.toggleLock, registered: false }
    }
    this.nativeFrame = { pending: null, inFlightSince: 0 }
    this.nativeCamera = new NativeCamera({
      resolveHelper: () => ensureCaptureHelper(path.join(app.getPath('userData'), 'native')),
      onFrame: (frame) => this.deliverNativeFrame(frame),
      onStatus: (status) => {
        this.runtime.nativeCamera = status
        this.scheduleBroadcast()
      }
    })
  }

  start() {
    this.registerIpc()
    for (const id of OVERLAY_IDS) this.createOverlay(id)
    this.applyLock()
    this.registerHotkey()
    this.syncNativeCamera()
    if (!this.isLocked()) this.showPanel()
  }

  getState() {
    return { settings: this.store.get(), runtime: this.runtime }
  }

  isLocked() {
    return this.store.get().locked
  }

  onChange(listener) {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  // ---------------------------------------------------------------- windows

  createOverlay(id) {
    const bounds = ensureVisible(this.store.get().overlays[id].bounds)
    this.store.patchOverlay(id, { bounds })

    const win = new BrowserWindow({
      ...bounds,
      title: OVERLAY_TITLES[id],
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      // Transparent frameless windows can't be resized natively on Windows: we do it ourselves.
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: { ...this.secureWebPreferences(), backgroundThrottling: false }
    })

    win.setAlwaysOnTop(true, 'screen-saver')
    win.on('always-on-top-changed', (_event, isOnTop) => {
      if (!isOnTop) win.setAlwaysOnTop(true, 'screen-saver')
    })
    win.on('move', () => this.syncBoundsFromWindow(id))
    win.on('resize', () => this.syncBoundsFromWindow(id))
    // Right-click on a drag region opens the Windows system menu: never useful here.
    win.on('system-context-menu', (event) => event.preventDefault())
    // Alt+F4 on an overlay hides it instead of destroying it.
    win.on('close', (event) => {
      if (this.quitting) return
      event.preventDefault()
      this.updateOverlay(id, { visible: false })
    })
    win.on('session-end', () => this.prepareQuit())
    win.on('closed', () => this.overlays.delete(id))
    win.webContents.on('render-process-gone', () => this.endResize())
    // A (re)loaded page never acks the frame sent to its previous instance.
    win.webContents.on('did-finish-load', () => {
      if (id === 'camera') this.nativeFrame.inFlightSince = 0
    })
    win.once('ready-to-show', () => {
      if (this.store.get().overlays[id].visible) win.showInactive()
    })

    win.loadURL(pageUrl(id))
    this.overlays.set(id, win)
  }

  showPanel() {
    if (this.panel && !this.panel.isDestroyed()) {
      if (this.panel.isMinimized()) this.panel.restore()
      this.panel.show()
      this.panel.focus()
      return
    }

    const panel = new BrowserWindow({
      width: 460,
      height: 860,
      minWidth: 400,
      minHeight: 520,
      title: 'Twitch Streamer Overlays',
      backgroundColor: '#0e0e10',
      autoHideMenuBar: true,
      show: false,
      webPreferences: this.secureWebPreferences()
    })
    panel.once('ready-to-show', () => panel.show())
    panel.on('closed', () => {
      if (this.panel === panel) this.panel = null
    })
    panel.loadURL(pageUrl('panel'))
    this.panel = panel
  }

  secureWebPreferences() {
    return {
      preload: this.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  }

  *windows() {
    for (const win of this.overlays.values()) if (!win.isDestroyed()) yield win
    if (this.panel && !this.panel.isDestroyed()) yield this.panel
  }

  // ------------------------------------------------------------------ state

  updateOverlay(id, patch) {
    if (!OVERLAY_IDS.includes(id)) return
    if (!this.store.patchOverlay(id, patch)) return
    this.applyWindowState(id)
    if (id === 'camera') this.syncNativeCamera()
    this.scheduleBroadcast()
  }

  // ---------------------------------------------------------- native camera

  /** Native mode bypasses Chromium's capture (which drops alpha) via the DirectShow helper. */
  syncNativeCamera() {
    const camera = this.store.get().overlays.camera
    if (!camera.visible || camera.keyMode !== 'native') {
      this.nativeCamera.setTarget(null)
      return
    }
    // Ask for the overlay's real pixel size: the helper downscales to the smallest size covering it.
    const { scaleFactor } = screen.getDisplayMatching(camera.bounds)
    this.nativeCamera.setTarget({
      device: this.nativeDeviceName(camera.deviceId),
      width: Math.ceil(camera.bounds.width * scaleFactor),
      height: Math.ceil(camera.bounds.height * scaleFactor)
    })
  }

  /** Chromium labels are DirectShow FriendlyNames (sometimes + " (vid:pid)"); the helper matches by prefix. */
  nativeDeviceName(deviceId) {
    const label = this.runtime.cameraDevices.find((device) => device.deviceId === deviceId)?.label
    return label || DEFAULT_NATIVE_DEVICE
  }

  /**
   * Flow control: at most one frame in flight to the renderer. Newer frames replace the pending
   * one instead of queueing, so a busy renderer drops frames rather than accumulating latency.
   */
  deliverNativeFrame(frame) {
    this.nativeFrame.pending = frame
    const { inFlightSince } = this.nativeFrame
    if (!inFlightSince || Date.now() - inFlightSince > FRAME_ACK_TIMEOUT_MS) this.flushNativeFrame()
  }

  flushNativeFrame() {
    const frame = this.nativeFrame.pending
    const win = this.overlays.get('camera')
    if (!frame || !win || win.isDestroyed()) {
      this.nativeFrame.inFlightSince = 0
      return
    }
    this.nativeFrame.pending = null
    this.nativeFrame.inFlightSince = Date.now()
    win.webContents.send('camera:native-frame', frame)
  }

  applyWindowState(id) {
    const win = this.overlays.get(id)
    if (!win || win.isDestroyed()) return

    const { bounds, visible } = this.store.get().overlays[id]
    if (!sameBounds(win.getBounds(), bounds)) win.setBounds(bounds)
    if (visible && !win.isVisible()) win.showInactive()
    if (!visible && win.isVisible()) win.hide()
  }

  /** Called when the OS moved the window (native drag). Only records, never pushes back. */
  syncBoundsFromWindow(id) {
    const win = this.overlays.get(id)
    if (!win || win.isDestroyed()) return
    if (this.store.patchOverlay(id, { bounds: win.getBounds() })) this.scheduleBroadcast()
  }

  setLocked(locked) {
    if (!this.store.setLocked(locked)) return
    this.applyLock()
    this.broadcastNow()
  }

  toggleLock() {
    this.setLocked(!this.isLocked())
  }

  /** Locked = click-through: every click reaches the game underneath. */
  applyLock() {
    const locked = this.isLocked()
    if (locked) this.endResize()
    for (const win of this.overlays.values()) {
      if (win.isDestroyed()) continue
      win.setIgnoreMouseEvents(locked)
      if (locked && win.isFocused()) win.blur()
      win.setAlwaysOnTop(true, 'screen-saver')
    }
  }

  resetPositions() {
    const defaults = createDefaults(screen.getPrimaryDisplay().workArea)
    for (const id of OVERLAY_IDS) {
      this.updateOverlay(id, { bounds: defaults.overlays[id].bounds, visible: true })
    }
  }

  scheduleBroadcast() {
    if (this.broadcastTimer) return
    this.broadcastTimer = setTimeout(() => this.broadcastNow(), BROADCAST_DELAY_MS)
  }

  broadcastNow() {
    clearTimeout(this.broadcastTimer)
    this.broadcastTimer = null
    const state = this.getState()
    for (const win of this.windows()) win.webContents.send('state:changed', state)
    for (const listener of this.changeListeners) listener(state)
  }

  // ----------------------------------------------------------------- resize

  /**
   * Main-driven resize: polling the real cursor position is stable, while the
   * renderer's screenX jitters because the window moves under the pointer.
   */
  beginResize(id, edge) {
    if (this.isLocked() || !RESIZE_EDGES.has(edge)) return
    this.endResize()

    const origin = screen.getCursorScreenPoint()
    const start = { ...this.store.get().overlays[id].bounds }
    const timer = setInterval(() => {
      const cursor = screen.getCursorScreenPoint()
      this.updateOverlay(id, { bounds: resizeBounds(start, edge, cursor.x - origin.x, cursor.y - origin.y) })
    }, RESIZE_TICK_MS)

    this.resizeSession = { id, timer }
  }

  endResize() {
    if (!this.resizeSession) return
    clearInterval(this.resizeSession.timer)
    this.resizeSession = null
  }

  // ----------------------------------------------------------------- hotkey

  /** Tries the configured shortcut first; if another app owns it, falls back so unlocking never depends on the tray alone. */
  registerHotkey() {
    const configured = this.store.get().hotkeys.toggleLock
    const candidates = [configured, ...FALLBACK_HOTKEYS.filter((accelerator) => accelerator !== configured)]

    for (const accelerator of candidates) {
      if (this.tryRegisterHotkey(accelerator)) {
        this.runtime.hotkey = { accelerator, configured, registered: true }
        return
      }
    }
    this.runtime.hotkey = { accelerator: configured, configured, registered: false }
  }

  tryRegisterHotkey(accelerator) {
    try {
      return globalShortcut.register(accelerator, () => this.toggleLock())
    } catch (error) {
      console.warn(`[hotkey] Invalid accelerator "${accelerator}": ${error.message}`)
      return false
    }
  }

  // -------------------------------------------------------------------- IPC

  registerIpc() {
    ipcMain.handle('state:get', (event) => (isAppFrame(event) ? this.getState() : null))

    ipcMain.handle('overlay:update', (event, id, patch) => {
      if (this.isPanel(event)) this.updateOverlay(id, patch)
    })
    ipcMain.handle('lock:set', (event, locked) => {
      if (this.isPanel(event) && typeof locked === 'boolean') this.setLocked(locked)
    })
    ipcMain.handle('overlay:reset-positions', (event) => {
      if (this.isPanel(event)) this.resetPositions()
    })
    ipcMain.handle('assets:reveal-green-screen', async (event) => {
      if (!this.isPanel(event)) return
      const filePath = await writeGreenScreenImage(app.getPath('userData'))
      shell.showItemInFolder(filePath)
    })

    ipcMain.on('overlay:resize-begin', (event, edge) => {
      const id = this.overlayIdFor(event.sender)
      if (id) this.beginResize(id, edge)
    })
    ipcMain.on('overlay:resize-end', (event) => {
      const id = this.overlayIdFor(event.sender)
      if (id && this.resizeSession?.id === id) this.endResize()
    })

    ipcMain.on('runtime:camera-devices', (event, devices) => {
      if (this.overlayIdFor(event.sender) !== 'camera') return
      this.runtime.cameraDevices = sanitizeDevices(devices)
      this.syncNativeCamera() // labels may resolve the native device name now
      this.scheduleBroadcast()
    })
    ipcMain.on('camera:native-frame-ack', (event) => {
      if (this.overlayIdFor(event.sender) !== 'camera') return
      this.nativeFrame.inFlightSince = 0
      this.flushNativeFrame()
    })
    ipcMain.on('runtime:chat-status', (event, status) => {
      if (this.overlayIdFor(event.sender) !== 'chat') return
      const clean = sanitizeChatStatus(status)
      if (!clean) return
      this.runtime.chatStatus = clean
      this.scheduleBroadcast()
    })
  }

  isPanel(event) {
    return Boolean(this.panel) && !this.panel.isDestroyed() && event.sender === this.panel.webContents && isAppFrame(event)
  }

  overlayIdFor(sender) {
    for (const [id, win] of this.overlays) {
      if (!win.isDestroyed() && win.webContents === sender) return id
    }
    return null
  }

  // -------------------------------------------------------------- lifecycle

  quit() {
    this.prepareQuit()
    app.quit()
  }

  prepareQuit() {
    this.quitting = true
    this.store.flush()
  }

  dispose() {
    this.endResize()
    this.nativeCamera.dispose()
    clearTimeout(this.broadcastTimer)
    globalShortcut.unregisterAll()
    this.store.flush()
  }
}

function isAppFrame(event) {
  return event.senderFrame?.url.startsWith(APP_ORIGIN) ?? false
}

function sameBounds(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function resizeBounds(start, edge, dx, dy) {
  const horizontal = edge.includes('e') ? dx : edge.includes('w') ? -dx : 0
  const vertical = edge.includes('s') ? dy : edge.includes('n') ? -dy : 0
  const width = Math.max(MIN_OVERLAY_SIZE.width, start.width + horizontal)
  const height = Math.max(MIN_OVERLAY_SIZE.height, start.height + vertical)

  // Dragging the left/top edge keeps the opposite edge anchored.
  return {
    x: edge.includes('w') ? start.x + start.width - width : start.x,
    y: edge.includes('n') ? start.y + start.height - height : start.y,
    width,
    height
  }
}

/** If a monitor was unplugged, pull the overlay back onto the closest display. */
function ensureVisible(bounds) {
  const area = screen.getDisplayMatching(bounds).workArea
  const visibleWidth = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
  const visibleHeight = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
  if (visibleWidth >= MIN_VISIBLE_PX && visibleHeight >= MIN_VISIBLE_PX) return bounds

  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height
  }
}

function sanitizeDevices(devices) {
  if (!Array.isArray(devices)) return []
  return devices
    .slice(0, 32)
    .filter((device) => typeof device?.deviceId === 'string' && typeof device?.label === 'string')
    .map((device) => ({ deviceId: device.deviceId.slice(0, 256), label: device.label.slice(0, 128) }))
}

function sanitizeChatStatus(status) {
  if (!CHAT_STATES.has(status?.state)) return null
  return {
    state: status.state,
    channel: typeof status.channel === 'string' ? status.channel.slice(0, 25) : '',
    detail: typeof status.detail === 'string' ? status.detail.slice(0, 200) : ''
  }
}

module.exports = { OverlayController }

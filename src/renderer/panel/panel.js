const api = window.overlayApi

const FORMATTERS = {
  percent: (value) => `${Math.round(value * 100)} %`,
  percentRaw: (value) => `${Math.round(value)} %`,
  px: (value) => `${value} px`,
  seconds: (value) => (value === 0 ? 'nunca' : `${value} s`),
  decimal: (value) => value.toFixed(2),
  integer: (value) => String(value)
}

const NATIVE_STATUS_TEXT = {
  idle: () => '',
  starting: ({ detail }) => detail || 'Iniciando…',
  running: ({ detail }) => `Transparencia nativa activa · ${detail}`,
  error: ({ detail }) => detail || 'Error en la captura nativa.'
}

const CHAT_STATUS_TEXT = {
  idle: () => 'Sin canal configurado.',
  connecting: ({ channel }) => `Conectando a #${channel}…`,
  connected: ({ channel }) => `Conectado a #${channel} (solo lectura, sin login).`,
  reconnecting: ({ detail }) => `Sin conexión con Twitch. ${detail}`.trim(),
  error: ({ detail }) => detail || 'Error con el chat.'
}

/**
 * Declarative bindings: every control has data-bind="overlayId.field.path".
 * Controls send patches; the UI only ever renders what the main process broadcasts back.
 */
const bindings = [...document.querySelectorAll('[data-bind]')]
const displays = [...document.querySelectorAll('[data-display]')]
const conditionals = [...document.querySelectorAll('[data-show-when]')]
const lockButton = document.getElementById('lock-button')
const lockStatus = document.getElementById('lock-status')
const hotkeyHint = document.getElementById('hotkey-hint')
const deviceSelect = document.getElementById('camera-device')
const chatStatus = document.getElementById('chat-status')
const nativeStatus = document.getElementById('native-status')

let currentState = null
let deviceSignature = ''

for (const control of bindings) {
  const eventName = control.dataset.commit === 'change' ? 'change' : 'input'
  control.addEventListener(eventName, () => commit(control))
}
lockButton.addEventListener('click', () => {
  if (currentState) api.setLocked(!currentState.settings.locked)
})
document.getElementById('reset-button').addEventListener('click', () => api.resetPositions())
document.getElementById('green-screen-button').addEventListener('click', () => api.revealGreenScreenImage())

api.onStateChanged(render)
api.getState().then(render)

function commit(control) {
  const [overlayId, ...path] = control.dataset.bind.split('.')
  const value = readControl(control)
  if (value === undefined) return
  const patch = path.reduceRight((inner, key) => ({ [key]: inner }), value)
  api.updateOverlay(overlayId, patch)
}

function readControl(control) {
  if (control.type === 'checkbox') return control.checked
  if (control.type === 'range' || control.type === 'number') {
    const value = control.valueAsNumber
    return Number.isFinite(value) ? value : undefined
  }
  return control.value
}

function render(state) {
  if (!state) return
  currentState = state
  const { settings, runtime } = state

  renderDeviceOptions(runtime.cameraDevices, settings.overlays.camera.deviceId)

  for (const control of bindings) {
    // Don't overwrite what the user is typing or dragging right now.
    const isEditing = control === document.activeElement && control.type !== 'checkbox' && control.tagName !== 'SELECT'
    if (!isEditing) writeControl(control, readPath(settings.overlays, control.dataset.bind))
  }

  for (const output of displays) {
    const value = readPath(settings.overlays, output.dataset.display)
    const format = FORMATTERS[output.dataset.format] ?? FORMATTERS.integer
    output.textContent = typeof value === 'number' ? format(value) : ''
  }

  for (const element of conditionals) {
    const [path, expected] = element.dataset.showWhen.split('=')
    element.hidden = String(readPath(settings.overlays, path)) !== expected
  }

  renderLock(settings.locked, runtime.hotkey)
  chatStatus.textContent = CHAT_STATUS_TEXT[runtime.chatStatus.state]?.(runtime.chatStatus) ?? ''
  chatStatus.dataset.state = runtime.chatStatus.state
  nativeStatus.textContent = NATIVE_STATUS_TEXT[runtime.nativeCamera.state]?.(runtime.nativeCamera) ?? ''
  nativeStatus.dataset.state = runtime.nativeCamera.state
}

function writeControl(control, value) {
  if (value === undefined) return
  if (control.type === 'checkbox') control.checked = Boolean(value)
  else control.value = String(value)
}

function renderDeviceOptions(devices, selectedId) {
  const named = devices.map((device, index) => ({ ...device, label: device.label || `Cámara ${index + 1}` }))
  const options = [{ deviceId: '', label: 'Automática (prefiere NVIDIA Broadcast)' }, ...named]
  if (selectedId && !devices.some((device) => device.deviceId === selectedId)) {
    options.push({ deviceId: selectedId, label: 'Cámara guardada (no conectada)' })
  }

  const signature = JSON.stringify(options)
  if (signature === deviceSignature) return
  deviceSignature = signature
  deviceSelect.replaceChildren(...options.map(({ deviceId, label }) => new Option(label, deviceId)))
}

function renderLock(locked, hotkey) {
  document.body.classList.toggle('is-locked', locked)
  lockButton.textContent = locked ? 'Desbloquear overlays' : 'Bloquear overlays'
  lockStatus.textContent = locked
    ? 'Bloqueado: los clicks pasan al juego.'
    : 'Modo edición: arrastrá y redimensioná los overlays.'

  const shortcut = formatAccelerator(hotkey.accelerator)
  const configured = formatAccelerator(hotkey.configured ?? hotkey.accelerator)
  const usingFallback = hotkey.registered && shortcut !== configured

  if (!hotkey.registered) {
    hotkeyHint.textContent = `No pude registrar ningún atajo (${configured} y los alternativos están ocupados). Desbloqueá desde el ícono de la bandeja.`
  } else if (usingFallback) {
    hotkeyHint.textContent = `Atajo global ${shortcut} (${configured} lo usa otra app): bloquea/desbloquea aunque estés dentro del juego.`
  } else {
    hotkeyHint.textContent = `Atajo global ${shortcut}: bloquea/desbloquea aunque estés dentro del juego.`
  }
  hotkeyHint.classList.toggle('is-warning', !hotkey.registered)
}

function formatAccelerator(accelerator) {
  return accelerator.replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl')
}

function readPath(target, path) {
  return path.split('.').reduce((node, key) => node?.[key], target)
}

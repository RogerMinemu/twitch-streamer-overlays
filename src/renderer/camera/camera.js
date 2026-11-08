import { mountOverlayFrame } from '../shared/overlay-frame.js'
import { createChromaKeyRenderer } from './chroma-key-renderer.js'

const PREFERRED_DEVICE = /nvidia broadcast/i
const DEFAULT_FPS = 30

const api = window.overlayApi
const video = document.getElementById('camera-video')
const canvas = document.getElementById('camera-canvas')
const clip = document.getElementById('camera-clip')
const message = document.getElementById('camera-message')
const frame = mountOverlayFrame({ title: 'Cámara' })
const renderer = createChromaKeyRenderer(canvas)

let config = null
let stream = null
/** undefined = not decided yet, null = camera off, '' = automatic, otherwise a deviceId. */
let requestedDeviceId
let openSequence = 0
let frameInterval = 1000 / DEFAULT_FPS
let lastDrawAt = 0

// Native frames: until proven otherwise we assume straight alpha (safe: worst case slightly darker edges).
let alphaMode = 'unknown' // 'unknown' | 'premultiplied' | 'straight'
let premultipliedEvidence = 0
let nativeFrameCount = 0

if (!renderer) document.body.classList.add('no-webgl')

api.onStateChanged(applyState)
api.getState().then(applyState)
api.onNativeFrame(handleNativeFrame)
navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange)
reportDevices() // main needs device labels even if we start directly in native mode
requestAnimationFrame(renderLoop)

function applyState({ settings, runtime }) {
  config = settings.overlays.camera
  frame.update(settings, config)
  clip.style.borderRadius = `${config.cornerRadius}%`
  document.body.classList.toggle('is-mirrored', config.mirror)

  // Native mode reads the camera through the DirectShow helper, so getUserMedia must let go.
  // A hidden overlay also releases the camera: no point burning GPU/USB while it's off.
  const isNative = config.keyMode === 'native'
  const wanted = config.visible && !isNative ? config.deviceId : null
  if (wanted !== requestedDeviceId) openCamera(wanted)
  if (isNative) showMessage(describeNativeStatus(runtime.nativeCamera))
}

/** Raw BGRA frame from the native helper (with NVIDIA's real alpha). Always ack, or main stops sending. */
function handleNativeFrame(nativeFrame) {
  try {
    if (renderer && config?.visible && config.keyMode === 'native') {
      if (nativeFrameCount++ % 15 === 0) updateAlphaMode(nativeFrame.pixels)
      renderer.drawPixels(nativeFrame, config, alphaMode === 'premultiplied')
    }
  } finally {
    api.ackNativeFrame()
  }
}

/**
 * Premultiplied data can never have a color channel above its alpha. One clear violation
 * proves straight alpha; repeated translucent samples without violations mean premultiplied.
 */
function updateAlphaMode(pixels) {
  if (alphaMode === 'straight') return
  const step = Math.max(4, Math.floor(pixels.length / 4 / 4096) * 4)
  let translucent = 0
  for (let i = 0; i < pixels.length; i += step) {
    const alpha = pixels[i + 3]
    if (alpha === 255) continue
    if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > alpha + 8) {
      alphaMode = 'straight'
      return
    }
    translucent++
  }
  if (translucent > 0 && ++premultipliedEvidence >= 4) alphaMode = 'premultiplied'
}

function describeNativeStatus(status) {
  if (status?.state === 'starting') return 'Iniciando transparencia nativa…'
  if (status?.state === 'error') return status.detail
  return ''
}

async function openCamera(deviceId) {
  requestedDeviceId = deviceId
  const sequence = ++openSequence
  stopStream()
  if (deviceId === null) return

  showMessage('')
  try {
    const target = deviceId || (await findPreferredDeviceId())
    let next = await requestStream(target)

    // Before the first permission grant, device labels can be empty, so "automatic"
    // may have opened the default webcam. Now that labels exist, look for NVIDIA again.
    if (!deviceId && !target) {
      const preferred = await findPreferredDeviceId()
      if (preferred && preferred !== trackDeviceId(next)) {
        stopTracks(next)
        next = await requestStream(preferred)
      }
    }

    // A newer request (user picked another camera meanwhile) wins.
    if (sequence !== openSequence) {
      stopTracks(next)
      return
    }
    attachStream(next)
  } catch (error) {
    if (sequence === openSequence) showMessage(describeCameraError(error))
  } finally {
    if (sequence === openSequence) reportDevices()
  }
}

function requestStream(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      // NVIDIA Broadcast can expose ONLY 4K: without crop-and-scale Chromium hands us 3840×2160
      // and we'd upload ~1 GB/s of texture for a ~400 px overlay while the game needs the GPU.
      resizeMode: 'crop-and-scale',
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: DEFAULT_FPS }
    }
  })
}

function attachStream(next) {
  stream = next
  const [track] = next.getVideoTracks()
  frameInterval = 1000 / (track?.getSettings().frameRate || DEFAULT_FPS)
  track?.addEventListener('ended', () => showMessage('La cámara se desconectó.'))
  video.srcObject = next
  video.play().catch(() => showMessage('No se pudo reproducir la cámara.'))
}

function stopStream() {
  if (!stream) return
  stopTracks(stream)
  stream = null
  video.srcObject = null
  renderer?.clear()
}

function stopTracks(mediaStream) {
  for (const track of mediaStream.getTracks()) track.stop()
}

function trackDeviceId(mediaStream) {
  return mediaStream?.getVideoTracks()[0]?.getSettings().deviceId ?? ''
}

async function listVideoDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((device) => device.kind === 'videoinput' && device.deviceId)
}

async function findPreferredDeviceId() {
  const devices = await listVideoDevices()
  return devices.find((device) => PREFERRED_DEVICE.test(device.label))?.deviceId ?? ''
}

async function reportDevices() {
  try {
    const devices = await listVideoDevices()
    // Raw labels (possibly empty): main uses them to find the same camera in DirectShow.
    api.reportCameraDevices(devices.map((device) => ({ deviceId: device.deviceId, label: device.label })))
  } catch {
    // enumerateDevices can fail transiently; the next devicechange retries.
  }
}

/** Camera plugged/unplugged, or NVIDIA Broadcast started after us. */
async function handleDeviceChange() {
  await reportDevices()
  if (requestedDeviceId === null || requestedDeviceId === undefined) return

  const isLive = stream?.getVideoTracks()[0]?.readyState === 'live'
  if (!isLive) {
    openCamera(requestedDeviceId)
    return
  }
  if (requestedDeviceId === '') {
    const preferred = await findPreferredDeviceId()
    if (preferred && preferred !== trackDeviceId(stream)) openCamera('')
  }
}

/** Draw only as often as the camera produces frames, not at the monitor's refresh rate. */
function renderLoop(now) {
  requestAnimationFrame(renderLoop)
  if (!renderer || !stream || !config || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
  if (now - lastDrawAt < frameInterval - 1) return
  lastDrawAt = now
  renderer.draw(video, config)
}

function showMessage(text) {
  message.textContent = text
  message.hidden = !text
}

function describeCameraError(error) {
  switch (error?.name) {
    case 'NotAllowedError':
      return 'Permiso de cámara denegado.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No encuentro esa cámara. Elegí otra en el panel.'
    case 'NotReadableError':
      return 'La cámara no responde o está bloqueada por otra app.'
    default:
      return `No se pudo abrir la cámara (${error?.name ?? 'error desconocido'}).`
  }
}

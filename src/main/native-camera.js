const { spawn } = require('node:child_process')

const HEADER_SIZE = 16
const MAGIC = 'FRM1'
const MAX_DIMENSION = 8192
const RESTART_DEBOUNCE_MS = 700
const RETRY_DELAY_MS = 3000
const STOP_GRACE_MS = 1000
// Restart only if the overlay outgrows the stream, or the stream is this many times too big.
const WASTE_RATIO = 2.5

/**
 * Owns the dshow-capture.exe child process that reads NVIDIA Broadcast WITH its alpha channel.
 * Declarative API: setTarget({ device, width, height }) or setTarget(null). It decides
 * whether to start, restart (debounced: resizing fires at 60 Hz) or stop the helper.
 */
class NativeCamera {
  constructor({ resolveHelper, onFrame, onStatus }) {
    this.resolveHelper = resolveHelper
    this.onFrame = onFrame
    this.onStatus = onStatus
    this.wanted = null
    this.child = null
    this.active = null // { device, requested, output, source } of the current/starting process
    this.startTimer = null
    this.generation = 0
  }

  setTarget(target) {
    this.wanted = target
    if (!target) {
      this.cancelStart()
      this.stopProcess()
      this.setStatus('idle')
      return
    }
    if (this.isSatisfied(target)) {
      this.cancelStart()
      return
    }
    this.scheduleStart(this.child ? RESTART_DEBOUNCE_MS : 0)
  }

  dispose() {
    this.wanted = null
    this.cancelStart()
    this.stopProcess()
  }

  /** Is the running (or starting) stream good enough for this target? Avoids pointless restarts. */
  isSatisfied(target) {
    const current = this.active
    if (!current || current.device !== target.device) return false

    const size = current.output ?? current.requested
    // At factor 1 the helper already sends the full source: asking for more can't help.
    const atMaximum = Boolean(current.output && current.source && current.output.width >= current.source.width)
    const bigEnough = atMaximum || (target.width <= size.width && target.height <= size.height)
    const notWasteful = target.width * WASTE_RATIO >= size.width && target.height * WASTE_RATIO >= size.height
    return bigEnough && notWasteful
  }

  scheduleStart(delay) {
    this.cancelStart()
    this.startTimer = setTimeout(() => {
      this.startTimer = null
      this.start()
    }, delay)
  }

  cancelStart() {
    clearTimeout(this.startTimer)
    this.startTimer = null
  }

  async start() {
    const target = this.wanted
    if (!target) return
    const generation = ++this.generation

    this.stopProcess()
    this.active = { device: target.device, requested: { width: target.width, height: target.height }, output: null, source: null }
    this.setStatus('starting', 'Preparando la captura nativa…')

    let exePath
    try {
      exePath = await this.resolveHelper()
    } catch (error) {
      if (generation !== this.generation) return
      this.active = null
      this.setStatus('error', `No se pudo compilar el capturador: ${error.message}`)
      return
    }
    if (generation !== this.generation) return // a newer start() superseded this one

    const child = spawn(
      exePath,
      ['--capture', '--device', target.device, '--width', String(target.width), '--height', String(target.height)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    this.child = child
    let lastError = ''

    child.stdin.on('error', () => {}) // EPIPE if the helper already died: nothing to do
    child.stdout.on(
      'data',
      createFrameParser({
        onFrame: (frame) => {
          if (this.child === child) this.onFrame(frame)
        },
        onCorrupt: () => this.handleFailure(child, 'El capturador envió datos corruptos.')
      })
    )
    forEachLine(child.stderr, (line) => {
      const event = parseEvent(line) // NVIDIA's own driver also logs to stderr: ignore non-JSON
      if (!event || this.child !== child) return
      if (event.event === 'error') lastError = event.message
      if (event.event === 'started') {
        this.active.output = { width: event.width, height: event.height }
        this.active.source = { width: event.sourceWidth, height: event.sourceHeight }
        this.setStatus('running', `${event.width}×${event.height} (NVIDIA entrega ${event.sourceWidth}×${event.sourceHeight})`)
      }
    })
    child.on('error', (error) => this.handleFailure(child, error.message))
    child.on('exit', (code) => this.handleFailure(child, lastError || `El capturador terminó (código ${code}).`))
  }

  /** Unexpected death (NVIDIA Broadcast closed, camera unplugged...): report and retry. */
  handleFailure(child, message) {
    if (this.child !== child) return // we stopped it on purpose
    this.child = null
    this.active = null
    child.kill()
    this.setStatus('error', message)
    if (this.wanted) this.scheduleStart(RETRY_DELAY_MS)
  }

  stopProcess() {
    const child = this.child
    this.child = null
    this.active = null
    if (!child) return
    child.stdin.end() // the helper stops its graph and exits when stdin closes
    setTimeout(() => child.kill(), STOP_GRACE_MS).unref()
  }

  setStatus(state, detail = '') {
    this.onStatus({ state, detail })
  }
}

/** Reassembles "FRM1" frames from arbitrary stdout chunks without ever throwing in a 'data' handler. */
function createFrameParser({ onFrame, onCorrupt }) {
  let header = Buffer.alloc(0)
  let frame = null
  let filled = 0
  let size = null
  let broken = false

  return (chunk) => {
    if (broken) return
    let offset = 0
    while (offset < chunk.length) {
      if (!frame) {
        const take = Math.min(HEADER_SIZE - header.length, chunk.length - offset)
        header = Buffer.concat([header, chunk.subarray(offset, offset + take)])
        offset += take
        if (header.length < HEADER_SIZE) return

        const width = header.readInt32LE(4)
        const height = header.readInt32LE(8)
        if (header.toString('ascii', 0, 4) !== MAGIC || !isValidDimension(width) || !isValidDimension(height)) {
          broken = true
          onCorrupt()
          return
        }
        size = { width, height }
        frame = Buffer.allocUnsafe(width * height * 4)
        filled = 0
        header = Buffer.alloc(0)
      }

      const copied = chunk.copy(frame, filled, offset, Math.min(chunk.length, offset + frame.length - filled))
      filled += copied
      offset += copied
      if (filled === frame.length) {
        onFrame({ width: size.width, height: size.height, pixels: frame })
        frame = null
      }
    }
  }
}

function isValidDimension(value) {
  return Number.isInteger(value) && value > 0 && value <= MAX_DIMENSION
}

function forEachLine(stream, onLine) {
  let rest = ''
  stream.setEncoding('utf8')
  stream.on('data', (text) => {
    const lines = (rest + text).split(/\r?\n/)
    rest = lines.pop()
    for (const line of lines) if (line) onLine(line)
  })
}

function parseEvent(line) {
  if (!line.startsWith('{')) return null
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

module.exports = { NativeCamera }

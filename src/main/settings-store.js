const fs = require('node:fs')
const path = require('node:path')

const OVERLAY_IDS = ['camera', 'chat']
const MIN_OVERLAY_SIZE = { width: 120, height: 80 }
const MAX_COORDINATE = 32_000
const MAX_PATCH_DEPTH = 3
const SAVE_DELAY_MS = 300

/**
 * Sanitizers: each returns the cleaned value, or undefined to reject it.
 * Renderer input is untrusted, so ONLY fields listed below can ever be written.
 */
const rules = {
  boolean: () => (value) => (typeof value === 'boolean' ? value : undefined),
  number: (min, max) => (value) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : undefined,
  integer: (min, max) => (value) => {
    const clamped = rules.number(min, max)(value)
    return clamped === undefined ? undefined : Math.round(clamped)
  },
  oneOf: (...allowed) => (value) => (allowed.includes(value) ? value : undefined),
  text: (maxLength) => (value) => (typeof value === 'string' ? value.slice(0, maxLength) : undefined),
  hexColor: () => (value) =>
    typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined,
  twitchChannel: () => (value) => (typeof value === 'string' ? normalizeChannel(value) : undefined)
}

const COMMON_FIELDS = {
  visible: rules.boolean(),
  opacity: rules.number(0.05, 1),
  'bounds.x': rules.integer(-MAX_COORDINATE, MAX_COORDINATE),
  'bounds.y': rules.integer(-MAX_COORDINATE, MAX_COORDINATE),
  'bounds.width': rules.integer(MIN_OVERLAY_SIZE.width, 8000),
  'bounds.height': rules.integer(MIN_OVERLAY_SIZE.height, 8000)
}

const FIELDS_BY_OVERLAY = {
  camera: {
    ...COMMON_FIELDS,
    deviceId: rules.text(256),
    mirror: rules.boolean(),
    cornerRadius: rules.number(0, 50),
    keyMode: rules.oneOf('none', 'native', 'chroma', 'luma'),
    keyColor: rules.hexColor(),
    similarity: rules.number(0, 1),
    smoothness: rules.number(0.01, 1),
    spill: rules.number(0.01, 1),
    lumaThreshold: rules.number(0, 1)
  },
  chat: {
    ...COMMON_FIELDS,
    channel: rules.twitchChannel(),
    fontSize: rules.integer(10, 48),
    backgroundOpacity: rules.number(0, 1),
    messageLifetime: rules.integer(0, 600),
    maxMessages: rules.integer(10, 200)
  }
}

/** Accepts "MiCanal", "#micanal" or "https://twitch.tv/micanal" and returns "micanal". */
function normalizeChannel(raw) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?twitch\.tv\//, '')
    .replace(/^#/, '')
    .split(/[/?#]/)[0]
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 25)
}

/** Default layout: camera bottom-right, chat bottom-left of the given work area. */
function createDefaults(workArea) {
  const margin = 24
  const camera = { width: 320, height: 240 }
  const chat = { width: 340, height: 480 }

  return {
    locked: false,
    // Ctrl+Shift+L is commonly taken by other apps; a 4-key combo almost never clashes with games.
    hotkeys: { toggleLock: 'CommandOrControl+Alt+Shift+L' },
    overlays: {
      camera: {
        visible: true,
        opacity: 1,
        bounds: {
          x: workArea.x + workArea.width - camera.width - margin,
          y: workArea.y + workArea.height - camera.height - margin,
          ...camera
        },
        deviceId: '',
        mirror: true,
        cornerRadius: 8,
        keyMode: 'none',
        keyColor: '#00ff00',
        similarity: 0.4,
        smoothness: 0.08,
        spill: 0.1,
        lumaThreshold: 0.08
      },
      chat: {
        visible: true,
        opacity: 1,
        bounds: {
          x: workArea.x + margin,
          y: workArea.y + workArea.height - chat.height - margin,
          ...chat
        },
        channel: '',
        fontSize: 16,
        backgroundOpacity: 0.35,
        messageLifetime: 0,
        maxMessages: 60
      }
    }
  }
}

class SettingsStore {
  constructor(filePath, defaults) {
    this.filePath = filePath
    this.settings = structuredClone(defaults)
    this.saveTimer = null
    this.load()
  }

  get() {
    return this.settings
  }

  /** Merges a (deep, partial) patch into one overlay. Returns true if anything changed. */
  patchOverlay(id, patch) {
    const fields = FIELDS_BY_OVERLAY[id]
    if (!fields || !isPlainObject(patch)) return false

    const overlay = this.settings.overlays[id]
    let changed = false

    for (const [fieldPath, rawValue] of flatten(patch)) {
      if (!Object.hasOwn(fields, fieldPath)) continue
      const value = fields[fieldPath](rawValue)
      if (value === undefined || readPath(overlay, fieldPath) === value) continue
      writePath(overlay, fieldPath, value)
      changed = true
    }

    if (changed) this.scheduleSave()
    return changed
  }

  setLocked(locked) {
    if (typeof locked !== 'boolean' || this.settings.locked === locked) return false
    this.settings.locked = locked
    this.scheduleSave()
    return true
  }

  scheduleSave() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS)
  }

  /** Writes to a temp file first so a crash mid-write never leaves a corrupt settings file. */
  flush() {
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tempPath = `${this.filePath}.tmp`
      fs.writeFileSync(tempPath, JSON.stringify(this.settings, null, 2))
      fs.renameSync(tempPath, this.filePath)
    } catch (error) {
      console.error(`[settings] Could not save settings: ${error.message}`)
    }
  }

  /** Stored values go through the same sanitizers as live updates: a hand-edited file can't break the app. */
  load() {
    let stored
    try {
      stored = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`[settings] Ignoring unreadable settings file: ${error.message}`)
      return
    }
    if (!isPlainObject(stored)) return

    if (typeof stored.locked === 'boolean') this.settings.locked = stored.locked

    const hotkey = stored.hotkeys?.toggleLock
    if (typeof hotkey === 'string' && hotkey.length > 0 && hotkey.length <= 64) {
      this.settings.hotkeys.toggleLock = hotkey
    }

    for (const id of OVERLAY_IDS) {
      if (isPlainObject(stored.overlays?.[id])) this.patchOverlay(id, stored.overlays[id])
    }

    // Loading is not a user change: nothing to write back yet.
    clearTimeout(this.saveTimer)
    this.saveTimer = null
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function* flatten(value, prefix = '', depth = 0) {
  if (depth >= MAX_PATCH_DEPTH) return
  for (const [key, child] of Object.entries(value)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key
    if (isPlainObject(child)) yield* flatten(child, fieldPath, depth + 1)
    else yield [fieldPath, child]
  }
}

function readPath(target, fieldPath) {
  return fieldPath.split('.').reduce((node, key) => node?.[key], target)
}

function writePath(target, fieldPath, value) {
  const keys = fieldPath.split('.')
  const last = keys.pop()
  const parent = keys.reduce((node, key) => node[key], target)
  parent[last] = value
}

module.exports = { SettingsStore, createDefaults, OVERLAY_IDS, MIN_OVERLAY_SIZE }

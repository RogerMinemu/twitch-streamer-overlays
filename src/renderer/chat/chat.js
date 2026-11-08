import { mountOverlayFrame } from '../shared/overlay-frame.js'
import { createTwitchChatClient } from './twitch-chat-client.js'

// Twitch's default palette for users who never picked a name color.
const DEFAULT_NAME_COLORS = [
  '#ff0000', '#0000ff', '#008000', '#b22222', '#ff7f50', '#9acd32', '#ff4500', '#2e8b57',
  '#daa520', '#d2691e', '#5f9ea0', '#1e90ff', '#ff69b4', '#8a2be2', '#00ff7f'
]
const FADE_OUT_MS = 600
const STATUS_TEXT = {
  idle: () => 'Escribí tu canal de Twitch en el panel.',
  connecting: ({ channel }) => `Conectando a #${channel}…`,
  connected: ({ channel }) => `Conectado a #${channel}`,
  reconnecting: ({ detail }) => `Sin conexión con Twitch. ${detail}`.trim(),
  error: ({ detail }) => detail || 'Error con el chat.'
}

const api = window.overlayApi
const list = document.getElementById('chat-messages')
const statusLine = document.getElementById('chat-status')
const frame = mountOverlayFrame({ title: 'Chat' })
let config = null

const client = createTwitchChatClient({
  onMessage: renderMessage,
  onClearChat: (login) => (login ? removeWhere((item) => item.dataset.login === login) : list.replaceChildren()),
  onDeleteMessage: (id) => removeWhere((item) => item.dataset.id === id),
  onStatus: (status) => {
    statusLine.textContent = STATUS_TEXT[status.state](status)
    statusLine.dataset.state = status.state
    api.reportChatStatus(status)
  }
})

api.onStateChanged(applyState)
api.getState().then(applyState)

function applyState({ settings }) {
  config = settings.overlays.chat
  frame.update(settings, config)

  const root = document.documentElement.style
  root.setProperty('--chat-font-size', `${config.fontSize}px`)
  root.setProperty('--chat-bg-alpha', String(config.backgroundOpacity))
  trimMessages()

  // Stays connected while hidden, so showing it again brings recent messages.
  client.join(config.channel)
}

/** Builds DOM nodes with textContent only: chat text is untrusted, never use innerHTML here. */
function renderMessage(message) {
  const item = document.createElement('li')
  item.className = 'chat-message'
  item.dataset.id = message.id
  item.dataset.login = message.login

  if (message.systemText) {
    item.classList.add('is-system')
    item.append(createSpan('chat-system', message.systemText))
  }

  if (message.parts.length > 0) {
    const color = readableColor(message.color || defaultColorFor(message.login))
    const author = createSpan('chat-author', message.displayName)
    author.style.color = color

    const body = createSpan('chat-text')
    for (const part of message.parts) body.append(part.type === 'emote' ? createEmote(part) : part.text)
    if (message.isAction) {
      item.classList.add('is-action')
      body.style.color = color
    }

    item.append(author, message.isAction ? ' ' : ': ', body)
  }

  if (item.childNodes.length === 0) return
  list.append(item)
  trimMessages()
  scheduleExpiry(item)
}

function createSpan(className, text = '') {
  const span = document.createElement('span')
  span.className = className
  span.textContent = text
  return span
}

function createEmote({ id, name }) {
  const image = document.createElement('img')
  image.className = 'chat-emote'
  image.src = `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/2.0`
  image.alt = name
  image.decoding = 'async'
  image.addEventListener('error', () => image.replaceWith(name), { once: true })
  return image
}

function trimMessages() {
  const max = config?.maxMessages ?? 60
  while (list.childElementCount > max) list.firstElementChild.remove()
}

function scheduleExpiry(item) {
  const seconds = config?.messageLifetime ?? 0
  if (seconds <= 0) return
  setTimeout(() => {
    item.classList.add('is-expired')
    setTimeout(() => item.remove(), FADE_OUT_MS)
  }, seconds * 1000)
}

function removeWhere(predicate) {
  for (const item of [...list.children]) {
    if (predicate(item)) item.remove()
  }
}

function defaultColorFor(login) {
  let hash = 0
  for (const char of login) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return DEFAULT_NAME_COLORS[hash % DEFAULT_NAME_COLORS.length]
}

/** Lightens dark name colors (e.g. pure blue) so they stay legible over a dark game. */
function readableColor(hex) {
  const value = Number.parseInt(hex.replace('#', ''), 16)
  if (!Number.isFinite(value)) return '#ffffff'

  const channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
  const luminance = (0.299 * channels[0] + 0.587 * channels[1] + 0.114 * channels[2]) / 255
  const mix = Math.max(0, (0.55 - luminance) / 0.55) * 0.6
  const [r, g, b] = channels.map((channel) => Math.round(channel + (255 - channel) * mix))
  return `rgb(${r} ${g} ${b})`
}

import { parseIrcLine, splitMessage } from './irc-parser.js'

const TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443'
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 30_000
// Twitch PINGs roughly every 5 minutes; silence beyond that means a dead connection.
const SILENCE_TIMEOUT_MS = 6 * 60_000
const WATCHDOG_INTERVAL_MS = 30_000
const ACTION_MESSAGE = /^\u0001ACTION (.*)\u0001$/

/**
 * Read-only, anonymous Twitch chat over IRC WebSocket. "justinfanNNNNN" is
 * Twitch's official anonymous login: no OAuth, no account, can't send messages.
 */
export function createTwitchChatClient(handlers) {
  let channel = null // null ≠ '' so the first join('') still reports the "idle" status
  let socket = null
  let reconnectTimer = null
  let watchdogTimer = null
  let attempts = 0
  let lastActivityAt = 0
  let state = 'idle'

  function setStatus(nextState, detail = '') {
    state = nextState
    handlers.onStatus({ state: nextState, channel, detail })
  }

  function join(nextChannel) {
    if (nextChannel === channel) return
    channel = nextChannel
    disconnect()
    attempts = 0
    if (channel) connect()
    else setStatus('idle')
  }

  function connect() {
    setStatus(attempts === 0 ? 'connecting' : 'reconnecting')
    const ws = new WebSocket(TWITCH_IRC_URL)
    socket = ws
    lastActivityAt = Date.now()

    ws.addEventListener('open', () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands')
      ws.send('PASS SCHMOOPIIE')
      ws.send(`NICK justinfan${10_000 + Math.floor(Math.random() * 89_999)}`)
      ws.send(`JOIN #${channel}`)
    })
    ws.addEventListener('message', (event) => {
      lastActivityAt = Date.now()
      for (const line of String(event.data).split('\r\n')) {
        if (line) handleLine(ws, line)
      }
    })
    ws.addEventListener('close', () => {
      if (socket === ws) dropSocketAndRetry()
    })

    watchdogTimer ??= setInterval(checkSilence, WATCHDOG_INTERVAL_MS)
  }

  function handleLine(ws, line) {
    const message = parseIrcLine(line)
    switch (message.command) {
      case 'PING':
        ws.send(`PONG :${message.params[0] ?? 'tmi.twitch.tv'}`)
        break
      case 'ROOMSTATE': // first ROOMSTATE = we're inside the channel
        attempts = 0
        if (state !== 'connected') setStatus('connected')
        break
      case 'PRIVMSG':
        handlers.onMessage(toChatMessage(message))
        break
      case 'USERNOTICE': // subs, resubs, raids, gifts...
        handlers.onMessage(toUserNotice(message))
        break
      case 'CLEARCHAT': // ban/timeout of one user, or /clear of the whole chat
        handlers.onClearChat(message.params[1] ?? null)
        break
      case 'CLEARMSG': // a moderator deleted one message
        if (message.tags['target-msg-id']) handlers.onDeleteMessage(message.tags['target-msg-id'])
        break
      case 'NOTICE':
        if (message.tags['msg-id'] === 'msg_channel_suspended') {
          setStatus('error', 'El canal no existe o está suspendido.')
        }
        break
      case 'RECONNECT': // Twitch is restarting that server: move to another one
        dropSocketAndRetry()
        break
    }
  }

  function dropSocketAndRetry() {
    const ws = socket
    socket = null
    ws?.close()
    scheduleReconnect()
  }

  function scheduleReconnect() {
    if (!channel || reconnectTimer) return
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempts)
    attempts += 1
    setStatus('reconnecting', `Reintento en ${Math.round(delay / 1000)} s`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function checkSilence() {
    if (socket && Date.now() - lastActivityAt > SILENCE_TIMEOUT_MS) dropSocketAndRetry()
  }

  function disconnect() {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    clearInterval(watchdogTimer)
    watchdogTimer = null
    const ws = socket
    socket = null // detach first so its 'close' event doesn't trigger a reconnect
    ws?.close()
  }

  return { join }
}

function toChatMessage(message) {
  const login = message.prefix.split('!')[0] || message.tags.login || ''
  let text = message.params[1] ?? ''
  const action = ACTION_MESSAGE.exec(text) // "/me does something"
  if (action) text = action[1]

  return {
    id: message.tags.id ?? '',
    login,
    displayName: message.tags['display-name'] || login,
    color: message.tags.color ?? '',
    isAction: Boolean(action),
    systemText: '',
    parts: splitMessage(text, message.tags.emotes)
  }
}

function toUserNotice(message) {
  const login = message.tags.login ?? ''
  const text = message.params[1] ?? ''
  return {
    id: message.tags.id ?? '',
    login,
    displayName: message.tags['display-name'] || login,
    color: message.tags.color ?? '',
    isAction: false,
    systemText: message.tags['system-msg'] ?? '',
    parts: text ? splitMessage(text, message.tags.emotes) : []
  }
}

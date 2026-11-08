const TAG_ESCAPES = { ':': ';', s: ' ', '\\': '\\', r: '\r', n: '\n' }
const EMOTE_ID = /^[\w-]+$/

/**
 * Parses one IRCv3 line from Twitch:
 * "@tags :prefix COMMAND param1 param2 :trailing param"
 */
export function parseIrcLine(line) {
  let rest = line
  let tags = Object.create(null)
  let prefix = ''

  if (rest.startsWith('@')) {
    const space = rest.indexOf(' ')
    if (space === -1) return { tags, prefix, command: '', params: [] }
    tags = parseTags(rest.slice(1, space))
    rest = rest.slice(space + 1)
  }

  if (rest.startsWith(':')) {
    const space = rest.indexOf(' ')
    if (space === -1) return { tags, prefix, command: '', params: [] }
    prefix = rest.slice(1, space)
    rest = rest.slice(space + 1)
  }

  let trailing = null
  const trailingStart = rest.indexOf(' :')
  if (trailingStart !== -1) {
    trailing = rest.slice(trailingStart + 2)
    rest = rest.slice(0, trailingStart)
  }

  const parts = rest.split(' ').filter(Boolean)
  const command = parts.shift() ?? ''
  const params = trailing === null ? parts : [...parts, trailing]
  return { tags, prefix, command, params }
}

function parseTags(raw) {
  // Null prototype: a tag literally named "__proto__" can't touch Object.prototype.
  const tags = Object.create(null)
  for (const pair of raw.split(';')) {
    const equals = pair.indexOf('=')
    const key = equals === -1 ? pair : pair.slice(0, equals)
    tags[key] = equals === -1 ? '' : pair.slice(equals + 1).replace(/\\(.)/g, (_, char) => TAG_ESCAPES[char] ?? char)
  }
  return tags
}

/**
 * Splits a chat message into text and emote parts using the "emotes" tag
 * ("25:0-4,12-16/1902:6-10"). Twitch counts positions in Unicode code points,
 * NOT UTF-16 units, so we index over Array.from(text) to handle emoji correctly.
 */
export function splitMessage(text, emotesTag) {
  const chars = Array.from(text)
  const ranges = []

  for (const group of (emotesTag ?? '').split('/')) {
    const [id, positions] = group.split(':')
    if (!id || !positions || !EMOTE_ID.test(id)) continue
    for (const position of positions.split(',')) {
      const [start, end] = position.split('-').map(Number)
      if (Number.isInteger(start) && Number.isInteger(end) && start <= end && end < chars.length) {
        ranges.push({ id, start, end })
      }
    }
  }
  ranges.sort((a, b) => a.start - b.start)

  const parts = []
  let cursor = 0
  for (const { id, start, end } of ranges) {
    if (start < cursor) continue // overlapping ranges: keep the first one
    if (start > cursor) parts.push({ type: 'text', text: chars.slice(cursor, start).join('') })
    parts.push({ type: 'emote', id, name: chars.slice(start, end + 1).join('') })
    cursor = end + 1
  }
  if (cursor < chars.length) parts.push({ type: 'text', text: chars.slice(cursor).join('') })
  return parts
}

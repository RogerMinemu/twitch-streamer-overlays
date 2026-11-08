const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')

const SOURCE_PATH = path.join(__dirname, '..', '..', 'native', 'dshow-capture.cs')
// The C# compiler that ships with every Windows 10/11 (.NET Framework 4): no SDK to install.
const CSC_PATH = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const HELPER_PREFIX = 'dshow-capture-'

let pending = null

/**
 * Returns the path to dshow-capture.exe, compiling native/dshow-capture.cs first if needed.
 * Cached by content hash: it only recompiles when the C# source changes.
 */
function ensureCaptureHelper(cacheDir) {
  pending ??= compile(cacheDir).catch((error) => {
    pending = null // allow a retry later
    throw error
  })
  return pending
}

async function compile(cacheDir) {
  const source = await fs.readFile(SOURCE_PATH)
  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)
  const exePath = path.join(cacheDir, `${HELPER_PREFIX}${hash}.exe`)
  if (await exists(exePath)) return exePath

  await fs.mkdir(cacheDir, { recursive: true })
  // Compile from a copy: the original could live inside an asar archive, which csc can't read.
  const sourceCopy = path.join(cacheDir, `${HELPER_PREFIX}${hash}.cs`)
  await fs.writeFile(sourceCopy, source)
  await run(CSC_PATH, [
    '/nologo',
    '/codepage:65001',
    '/unsafe',
    '/optimize+',
    '/platform:x64',
    '/target:exe',
    `/out:${exePath}`,
    sourceCopy
  ])
  await removeStaleBuilds(cacheDir, hash)
  return exePath
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error, stdout) => {
      // csc prints compile errors to stdout, not stderr.
      if (error) reject(new Error(String(stdout).trim() || error.message))
      else resolve()
    })
  })
}

async function removeStaleBuilds(cacheDir, currentHash) {
  const entries = await fs.readdir(cacheDir).catch(() => [])
  await Promise.all(
    entries
      .filter((name) => name.startsWith(HELPER_PREFIX) && !name.includes(currentHash))
      .map((name) => fs.rm(path.join(cacheDir, name), { force: true }).catch(() => {}))
  )
}

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

module.exports = { ensureCaptureHelper }

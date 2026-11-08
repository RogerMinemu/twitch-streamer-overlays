const fs = require('node:fs/promises')
const path = require('node:path')
const { nativeImage } = require('electron')

const WIDTH = 1280
const HEIGHT = 720
const FILE_NAME = 'fondo-verde-nvidia-broadcast.png'

/**
 * Writes a solid #00FF00 image to use as NVIDIA Broadcast "Background replacement".
 * The overlay then chroma-keys that green away, which works no matter how the
 * virtual camera's alpha channel reaches Chromium.
 */
async function writeGreenScreenImage(directory) {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4)
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = 0x00 // B
    pixels[offset + 1] = 0xff // G
    pixels[offset + 2] = 0x00 // R
    pixels[offset + 3] = 0xff // A
  }

  const filePath = path.join(directory, FILE_NAME)
  const png = nativeImage.createFromBitmap(pixels, { width: WIDTH, height: HEIGHT }).toPNG()
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(filePath, png)
  return filePath
}

module.exports = { writeGreenScreenImage }

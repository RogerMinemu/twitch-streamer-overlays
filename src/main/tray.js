const { Menu, Tray, nativeImage } = require('electron')

const ICON_SIZE = 32
const TWITCH_PURPLE = { r: 0x91, g: 0x46, b: 0xff }

/**
 * The tray is the safety net: a locked overlay can't be clicked, so if the
 * global hotkey is taken by another app, this is how the streamer unlocks.
 */
function createTray(controller) {
  const tray = new Tray(drawIcon(controller.isLocked()))
  tray.on('click', () => controller.showPanel())

  let signature = ''
  const refresh = ({ settings }) => {
    const { locked, overlays } = settings
    const next = `${locked}|${overlays.camera.visible}|${overlays.chat.visible}`
    if (next === signature) return
    signature = next

    tray.setImage(drawIcon(locked))
    tray.setToolTip(`Twitch Streamer Overlays · ${locked ? 'Bloqueado' : 'Modo edición'}`)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: locked ? 'Desbloquear overlays' : 'Bloquear overlays',
          click: () => controller.toggleLock()
        },
        { type: 'separator' },
        {
          label: 'Mostrar cámara',
          type: 'checkbox',
          checked: overlays.camera.visible,
          click: (item) => controller.updateOverlay('camera', { visible: item.checked })
        },
        {
          label: 'Mostrar chat',
          type: 'checkbox',
          checked: overlays.chat.visible,
          click: (item) => controller.updateOverlay('chat', { visible: item.checked })
        },
        { type: 'separator' },
        { label: 'Abrir panel de control', click: () => controller.showPanel() },
        { label: 'Salir', click: () => controller.quit() }
      ])
    )
  }

  controller.onChange(refresh)
  refresh(controller.getState())
  return tray
}

/** Drawn in code (no asset files): filled circle = locked, ring = editing. */
function drawIcon(locked) {
  const pixels = Buffer.alloc(ICON_SIZE * ICON_SIZE * 4)
  const center = (ICON_SIZE - 1) / 2
  const outerRadius = ICON_SIZE / 2 - 1
  const innerRadius = outerRadius - 6

  for (let y = 0; y < ICON_SIZE; y++) {
    for (let x = 0; x < ICON_SIZE; x++) {
      const distance = Math.hypot(x - center, y - center)
      let coverage = clamp01(outerRadius - distance + 0.5)
      if (!locked) coverage *= clamp01(distance - innerRadius + 0.5)

      // BGRA, premultiplied alpha.
      const offset = (y * ICON_SIZE + x) * 4
      pixels[offset] = Math.round(TWITCH_PURPLE.b * coverage)
      pixels[offset + 1] = Math.round(TWITCH_PURPLE.g * coverage)
      pixels[offset + 2] = Math.round(TWITCH_PURPLE.r * coverage)
      pixels[offset + 3] = Math.round(255 * coverage)
    }
  }

  return nativeImage.createFromBitmap(pixels, { width: ICON_SIZE, height: ICON_SIZE, scaleFactor: 2 })
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value))
}

module.exports = { createTray }

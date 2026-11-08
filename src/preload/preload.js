// Sandboxed preload: the ONLY bridge between pages and the main process.
// Pages get these functions and nothing else (no Node, no raw ipcRenderer).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlayApi', {
  getState: () => ipcRenderer.invoke('state:get'),
  onStateChanged: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('state:changed', listener)
    return () => ipcRenderer.removeListener('state:changed', listener)
  },

  // Control panel
  updateOverlay: (id, patch) => ipcRenderer.invoke('overlay:update', id, patch),
  setLocked: (locked) => ipcRenderer.invoke('lock:set', locked),
  resetPositions: () => ipcRenderer.invoke('overlay:reset-positions'),
  revealGreenScreenImage: () => ipcRenderer.invoke('assets:reveal-green-screen'),

  // Overlay windows
  beginResize: (edge) => ipcRenderer.send('overlay:resize-begin', edge),
  endResize: () => ipcRenderer.send('overlay:resize-end'),
  reportCameraDevices: (devices) => ipcRenderer.send('runtime:camera-devices', devices),
  onNativeFrame: (callback) => {
    const listener = (_event, frame) => callback(frame)
    ipcRenderer.on('camera:native-frame', listener)
    return () => ipcRenderer.removeListener('camera:native-frame', listener)
  },
  ackNativeFrame: () => ipcRenderer.send('camera:native-frame-ack'),
  reportChatStatus: (status) => ipcRenderer.send('runtime:chat-status', status)
})

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ml', {
  relaunch: (n) => ipcRenderer.invoke('relaunch', n),
  setLayout: (m) => ipcRenderer.send('set-layout', m),
  setSolo: (idx) => ipcRenderer.send('set-solo', idx),
  setSidebar: (collapsed) => ipcRenderer.send('set-sidebar', collapsed),
  getState: () => ipcRenderer.invoke('get-state'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s))
})

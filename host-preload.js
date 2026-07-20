const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ml', {
  relaunch: (n) => ipcRenderer.invoke('relaunch', n),
  addAccount: () => ipcRenderer.invoke('add-account'),
  closeAccount: (idx) => ipcRenderer.invoke('close-account', idx),
  setLayout: (m) => ipcRenderer.send('set-layout', m),
  setSolo: (idx) => ipcRenderer.send('set-solo', idx),
  setSidebar: (collapsed) => ipcRenderer.send('set-sidebar', collapsed),
  getState: () => ipcRenderer.invoke('get-state'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  login: (email, pass) => ipcRenderer.invoke('login', email, pass),
  signup: (email, pass) => ipcRenderer.invoke('signup', email, pass),
  logout: () => ipcRenderer.invoke('logout')
})

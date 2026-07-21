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
  logout: () => ipcRenderer.invoke('logout'),
  readLoot: () => ipcRenderer.invoke('read-loot'),
  openLoot: () => ipcRenderer.invoke('open-loot'),
  readDashboard: () => ipcRenderer.invoke('read-dashboard'),
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  applyUpdate: () => ipcRenderer.invoke('apply-update'),
  getProfile: () => ipcRenderer.invoke('get-profile'),
  saveProfile: (nome, discord, nick) => ipcRenderer.invoke('save-profile', nome, discord, nick),
  checkAdmin: () => ipcRenderer.invoke('check-admin'),
  listParticipants: () => ipcRenderer.invoke('list-participants')
})

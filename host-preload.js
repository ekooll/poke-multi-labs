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
  dashboardPin: (on) => ipcRenderer.invoke('dashboard-pin', on),
  dashboardMinimize: () => ipcRenderer.invoke('dashboard-minimize'),
  dashboardResize: (w, h) => ipcRenderer.invoke('dashboard-resize', w, h),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  applyUpdate: () => ipcRenderer.invoke('apply-update'),
  getProfile: () => ipcRenderer.invoke('get-profile'),
  saveProfile: (nome, discord, nick) => ipcRenderer.invoke('save-profile', nome, discord, nick),
  checkAdmin: () => ipcRenderer.invoke('check-admin'),
  listParticipants: () => ipcRenderer.invoke('list-participants'),
  // card flutuante (overlay por conta): arrastar, redimensionar, voltar pro canto e zerar
  cardMove: (num, dx, dy) => ipcRenderer.send('card:move', num, dx, dy),
  cardSize: (num, dw, dh) => ipcRenderer.send('card:size', num, dw, dh),
  cardHome: (num) => ipcRenderer.send('card:home', num),
  cardReset: (num) => ipcRenderer.invoke('card:reset', num)
})

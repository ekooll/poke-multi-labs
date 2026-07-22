const { contextBridge, ipcRenderer } = require('electron');
// (o objeto exposto abaixo ganha tambem toggleOverlay/getOverlay)
contextBridge.exposeInMainWorld('win', {
  minimize:  () => ipcRenderer.send('win:minimize'),
  maximize:  () => ipcRenderer.send('win:maximize'),
  close:     () => ipcRenderer.send('win:close'),
  toggleEco: () => ipcRenderer.invoke('lite:eco'),
  getEco:    () => ipcRenderer.invoke('lite:eco-state'),
  toggleFps: () => ipcRenderer.invoke('lite:fps'),
  getFps:    () => ipcRenderer.invoke('lite:fps-state'),
  toggleStats: () => ipcRenderer.invoke('lite:stats'),
  getStats:    () => ipcRenderer.invoke('lite:stats-state'),
  toggleOverlay: () => ipcRenderer.invoke('lite:overlay'),
  getOverlay:    () => ipcRenderer.invoke('lite:overlay-state'),
});

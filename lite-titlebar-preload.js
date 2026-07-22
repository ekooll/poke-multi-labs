const { contextBridge, ipcRenderer } = require('electron');
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
});

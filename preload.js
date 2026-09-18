const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    appVersion: ipcRenderer.sendSync('get-app-version'),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
});

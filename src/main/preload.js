const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sitAPI', {
    // Common
    getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
    openExternal: (url) => ipcRenderer.send('app:openExternal', url),

    // Splash
    chooseMode: (mode, remember) => ipcRenderer.send('app:chooseMode', { mode, remember }),

    // Auto-updater
    checkForUpdates: () => ipcRenderer.invoke('updater:check'),
    downloadUpdate: () => ipcRenderer.invoke('updater:download'),
    quitAndInstall: () => ipcRenderer.send('updater:quitAndInstall'),
    onUpdateProgress: (callback) => {
        const listener = (_event, pct) => callback(pct);
        ipcRenderer.on('updater:progress', listener);
    },

    // Server window
    getServerStatus: () => ipcRenderer.invoke('server:status'),
    getServerIps: () => ipcRenderer.invoke('server:getIps'),
    setServerPassword: (pwd) => ipcRenderer.invoke('server:setPassword', pwd),
    openServerLogs: () => ipcRenderer.send('server:openLogs'),
    onServerSnapshot: (callback) => {
        const listener = (_event, data) => callback(data);
        ipcRenderer.on('server:snapshot', listener);
    },
    quitApp: () => ipcRenderer.invoke('app:quit')
});

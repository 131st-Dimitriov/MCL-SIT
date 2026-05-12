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
    quitApp: () => ipcRenderer.invoke('app:quit'),

    // Maps library (V17)
    openMapsLibrary: () => ipcRenderer.send('app:openMapsLibrary'),
    mapsList: () => ipcRenderer.invoke('maps:list'),
    mapsGetThumbnail: (id) => ipcRenderer.invoke('maps:getThumbnail', id),
    mapsGetImage: (id) => ipcRenderer.invoke('maps:getImage', id),
    mapsAdd: (sourcePath, meta) => ipcRenderer.invoke('maps:add', sourcePath, meta),
    mapsUpdate: (id, patch) => ipcRenderer.invoke('maps:update', id, patch),
    mapsDelete: (id) => ipcRenderer.invoke('maps:delete', id),
    mapsPickFile: () => ipcRenderer.invoke('maps:pickFile'),
    mapsReadAsDataURL: (filePath) => ipcRenderer.invoke('maps:readAsDataURL', filePath),
    mapsLoad: (id) => ipcRenderer.invoke('maps:load', id),
    onMapsLoadMap: (callback) => {
        const listener = (_event, data) => callback(data);
        ipcRenderer.on('maps:loadMap', listener);
    },
    rendererReady: () => ipcRenderer.send('renderer:ready')
});

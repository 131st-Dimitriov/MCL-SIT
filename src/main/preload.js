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
    rendererReady: () => ipcRenderer.send('renderer:ready'),

    // V18 — server maps relay (SIT renderer side)
    notifyServerConnectionState: (state) => ipcRenderer.send('maps:notifyServerConnectionState', state),
    serverMapsListReceived: (list) => ipcRenderer.send('maps:serverMapsListReceived', list),
    mapUploadResultReceived: (msg) => ipcRenderer.send('maps:mapUploadResultReceived', msg),
    mapDeleteResultReceived: (msg) => ipcRenderer.send('maps:mapDeleteResultReceived', msg),
    mapDownloadMsgReceived: (msg) => ipcRenderer.send('maps:mapDownloadMsgReceived', msg),
    onMapsSendWS: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on('maps:sendWS', listener);
    },

    // V18 — server maps (maps library window side)
    getServerConnectionState: () => ipcRenderer.invoke('maps:getServerConnectionState'),
    getServerMapsList: () => ipcRenderer.invoke('maps:getServerMapsList'),
    mapsPublishToServer: (id) => ipcRenderer.invoke('maps:publishToServer', id),
    mapsDownloadFromServer: (id) => ipcRenderer.invoke('maps:downloadFromServer', id),
    mapsDeleteFromServer: (id) => ipcRenderer.invoke('maps:deleteFromServer', id),
    onServerConnectionState: (callback) => {
        const listener = (_event, state) => callback(state);
        ipcRenderer.on('maps:serverConnectionState', listener);
    },
    onServerMapsList: (callback) => {
        const listener = (_event, list) => callback(list);
        ipcRenderer.on('maps:serverMapsList', listener);
    },
    onMapDownloadProgress: (callback) => {
        const listener = (_event, info) => callback(info);
        ipcRenderer.on('maps:downloadProgress', listener);
    },
    onMapUploadProgress: (callback) => {
        const listener = (_event, info) => callback(info);
        ipcRenderer.on('maps:uploadProgress', listener);
    },
    onLocalLibraryChanged: (callback) => {
        const listener = () => callback();
        ipcRenderer.on('maps:localLibraryChanged', listener);
    },

    // V18 — capture
    openCaptureWindow: () => ipcRenderer.send('app:openCaptureWindow'),
    captureCheckPython: () => ipcRenderer.invoke('capture:checkPython'),
    captureSetupPython: () => ipcRenderer.invoke('capture:setupPython'),
    captureRun: (params) => ipcRenderer.invoke('capture:run', params),
    captureCancel: () => ipcRenderer.invoke('capture:cancel'),
    captureSaveToLibrary: (opts) => ipcRenderer.invoke('capture:saveToLibrary', opts),
    captureCleanupIntermediates: (paths) => ipcRenderer.invoke('capture:cleanupIntermediates', paths),
    captureOpenFolder: (folder) => ipcRenderer.send('capture:openFolder', folder),
    onCaptureSetupProgress: (callback) => {
        const listener = (_event, info) => callback(info);
        ipcRenderer.on('capture:setupProgress', listener);
    },
    onCaptureLog: (callback) => {
        const listener = (_event, line) => callback(line);
        ipcRenderer.on('capture:log', listener);
    }
});

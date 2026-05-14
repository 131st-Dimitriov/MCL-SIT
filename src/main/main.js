// =============================================================================
// MCL-SIT — Main process
// =============================================================================
// Modes :
//   - client : ouvre la fenêtre SIT
//   - server : ouvre la fenêtre Serveur (statut, joueurs, mot de passe)
//   - both   : démarre le serveur + ouvre la fenêtre SIT (PC unique solo)
// La fenêtre Serveur agit comme "centre de contrôle" : la fermer = arrêter
// le serveur et quitter l'app.
// =============================================================================

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeImage, net: electronNet } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const config = require('./config');
const serverHost = require('./server-host');
const hookCheck = require('./hook-check');
const autoUpdater = require('./auto-updater');
const logger = require('./logger');
const mapsLibrary = require('./maps-library');
const pythonSetup = require('./python-setup');
const captureRunner = require('./capture-runner');

logger.init();

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

let splashWindow = null;
let mainWindow = null;
let mapsWindow = null;
// Pending map to load when the SIT renderer is ready (used when "Load" is clicked
// from the maps library in standalone mode, before the SIT window exists)
let pendingMapLoad = null;
let serverWindow = null;
let logWindow = null;
let serverPassword = 'Scramble';
let cachedPublicIp = null;

function resolveIconPath() {
    if (app.isPackaged) {
        const p = path.join(process.resourcesPath, 'icon.ico');
        if (fs.existsSync(p)) return p;
    }
    const devP = path.join(__dirname, '..', '..', 'build', 'icon.ico');
    if (fs.existsSync(devP)) return devP;
    return null;
}

// ----------------------------------------------------------------------------
// Splash
// ----------------------------------------------------------------------------
function createSplashWindow() {
    splashWindow = new BrowserWindow({
        width: 560, height: 600,
        resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
        autoHideMenuBar: true,
        backgroundColor: '#0a1012',
        title: 'MCL-SIT',
        icon: resolveIconPath() || undefined,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true, sandbox: true, nodeIntegration: false,
            devTools: !app.isPackaged
        }
    });
    splashWindow.setMenu(null);
    splashWindow.loadFile(path.join(__dirname, 'splash.html'));
    splashWindow.once('ready-to-show', () => splashWindow.show());
    splashWindow.on('closed', () => { splashWindow = null; });
}

// ----------------------------------------------------------------------------
// Main SIT window (client)
// ----------------------------------------------------------------------------
function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1920, height: 1080, minWidth: 1280, minHeight: 720,
        show: false, backgroundColor: '#0a1012',
        autoHideMenuBar: true,
        title: 'MCL-SIT',
        icon: resolveIconPath() || undefined,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true, sandbox: true, nodeIntegration: false,
            devTools: !app.isPackaged
        }
    });
    const isDev = !app.isPackaged;
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            label: 'Fichier',
            submenu: [
                { role: 'reload', visible: isDev },
                { role: 'forceReload', visible: isDev },
                { type: 'separator' },
                {
                    label: 'Changer de mode...',
                    click: () => {
                        config.save({ mode: null, rememberMode: false });
                        app.relaunch();
                        app.quit();
                    }
                },
                { type: 'separator' },
                { role: 'quit', label: 'Quitter' }
            ]
        },
        {
            label: 'Affichage',
            submenu: [
                { role: 'togglefullscreen', label: 'Plein écran' },
                { role: 'zoomIn', label: 'Zoom +' },
                { role: 'zoomOut', label: 'Zoom -' },
                { role: 'resetZoom', label: 'Zoom 100%' },
                { type: 'separator' },
                { role: 'toggleDevTools', label: 'Outils de développement', visible: isDev }
            ]
        },
        {
            label: 'Aide',
            submenu: [
                {
                    label: 'À propos',
                    click: () => {
                        dialog.showMessageBox(mainWindow, {
                            type: 'info',
                            title: 'À propos',
                            message: 'MCL-SIT',
                            detail: 'Version ' + app.getVersion() + '\n\nAuteur : 131st-Dimitriov'
                        });
                    }
                }
            ]
        }
    ]));
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
        return { action: 'deny' };
    });
}

// ----------------------------------------------------------------------------
// Server window
// ----------------------------------------------------------------------------
function createServerWindow() {
    serverWindow = new BrowserWindow({
        width: 660, height: 720,
        resizable: false, minimizable: true, maximizable: false, fullscreenable: false,
        autoHideMenuBar: true,
        backgroundColor: '#0a1012',
        title: 'MCL-SIT — Serveur SIT',
        icon: resolveIconPath() || undefined,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true, sandbox: true, nodeIntegration: false,
            devTools: !app.isPackaged
        }
    });
    serverWindow.setMenu(null);
    serverWindow.loadFile(path.join(__dirname, 'server-window.html'));
    serverWindow.once('ready-to-show', () => serverWindow.show());

    // Closing the server window = quit app (per user spec: no tray)
    serverWindow.on('close', (e) => {
        // Confirm only if user clicks the X
        const choice = dialog.showMessageBoxSync(serverWindow, {
            type: 'warning',
            buttons: ['Arrêter le serveur', 'Annuler'],
            defaultId: 1,
            cancelId: 1,
            title: 'Arrêter le serveur ?',
            message: 'Cela arrêtera le serveur SIT et déconnectera tous les joueurs.',
            detail: 'Les joueurs connectés perdront leur connexion immédiatement.'
        });
        if (choice === 1) {
            // Cancel close
            e.preventDefault();
            return;
        }
        // OK to close — let it proceed; window-all-closed will quit the app
    });
    serverWindow.on('closed', () => {
        serverWindow = null;
        // Force quit even if other windows exist (server-mode is not viable without this window)
        if (!mainWindow) app.quit();
    });
}

// Forward server snapshots to the server window (and aggregate status)
function broadcastSnapshotToWindow() {
    if (!serverWindow || serverWindow.isDestroyed()) return;
    const snap = serverHost.getSnapshot();
    serverWindow.webContents.send('server:snapshot', {
        running: serverHost.isRunning(),
        port: snap.port || 5026,
        count: snap.count || 0,
        clients: snap.clients || []
    });
}

serverHost.onSnapshot(() => broadcastSnapshotToWindow());
serverHost.onExit(() => broadcastSnapshotToWindow());

// ----------------------------------------------------------------------------
// IP detection
// ----------------------------------------------------------------------------
function getLocalIp() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return '127.0.0.1';
}

function getPublicIp() {
    // Cache after first successful call
    if (cachedPublicIp) return Promise.resolve(cachedPublicIp);
    return new Promise((resolve) => {
        try {
            const req = electronNet.request('https://api.ipify.org?format=text');
            let body = '';
            req.on('response', (resp) => {
                resp.on('data', (chunk) => body += chunk.toString());
                resp.on('end', () => {
                    const ip = body.trim();
                    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
                        cachedPublicIp = ip;
                        resolve(ip);
                    } else {
                        resolve(null);
                    }
                });
                resp.on('error', () => resolve(null));
            });
            req.on('error', () => resolve(null));
            // 5s timeout
            setTimeout(() => resolve(null), 5000);
            req.end();
        } catch (e) {
            resolve(null);
        }
    });
}

// ----------------------------------------------------------------------------
// Log window (shared between modes)
// ----------------------------------------------------------------------------
function showServerLogs() {
    if (logWindow && !logWindow.isDestroyed()) {
        logWindow.focus();
        return;
    }
    logWindow = new BrowserWindow({
        width: 820, height: 520,
        title: 'Logs serveur — MCL-SIT',
        backgroundColor: '#0a1012',
        autoHideMenuBar: true,
        icon: resolveIconPath() || undefined,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
    });
    const logs = serverHost.getLogs().join('\n').replace(/&/g,'&amp;').replace(/</g,'&lt;');
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Logs</title>
<style>body{background:#0a1012;color:#c8d1c8;font-family:'Courier New',monospace;font-size:11px;padding:14px;margin:0;}
pre{white-space:pre-wrap;word-wrap:break-word;}
.hdr{color:#5fa8c2;font-weight:700;margin-bottom:10px;letter-spacing:1px;}</style></head><body>
<div class="hdr">LOGS SERVEUR — MCL-SIT</div>
<pre>${logs}</pre></body></html>`;
    logWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    logWindow.on('closed', () => { logWindow = null; });
}

// ----------------------------------------------------------------------------
// Mode launching
// ----------------------------------------------------------------------------
function launchMode(mode) {
    if (splashWindow) { splashWindow.close(); splashWindow = null; }
    if (mode === 'client') {
        createMainWindow();
    } else if (mode === 'server') {
        try { serverHost.startServer({ port: 5026, password: serverPassword }); }
        catch (e) { dialog.showErrorBox('Erreur démarrage serveur', e.message); }
        createServerWindow();
    } else if (mode === 'both') {
        // Open the SIT client window immediately, then start the server in background.
        // Previous version used setTimeout(500) which caused window-all-closed to fire
        // during the gap, quitting the app before the client window opened.
        createMainWindow();
        try { serverHost.startServer({ port: 5026, password: serverPassword }); }
        catch (e) { dialog.showErrorBox('Erreur démarrage serveur', e.message); }
    } else {
        createSplashWindow();
    }
    // Periodically push snapshots to the server window even when nothing changes
    setInterval(broadcastSnapshotToWindow, 2000);
}

// ----------------------------------------------------------------------------
// IPC
// ----------------------------------------------------------------------------
ipcMain.handle('app:getInfo', () => ({
    version: app.getVersion(),
    hookStatus: hookCheck.getStatus()
}));

ipcMain.on('app:chooseMode', (event, { mode, remember }) => {
    if (!['client', 'server', 'both'].includes(mode)) return;
    config.save({ mode, rememberMode: !!remember });
    launchMode(mode);
});

ipcMain.on('app:openExternal', (event, url) => {
    if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
        shell.openExternal(url);
    }
});

ipcMain.handle('server:status', () => {
    const snap = serverHost.getSnapshot();
    return {
        running: serverHost.isRunning(),
        port: snap.port || 5026,
        count: snap.count || 0,
        clients: snap.clients || [],
        password: serverPassword
    };
});

ipcMain.handle('server:getIps', async () => {
    const local = getLocalIp();
    const pub = await getPublicIp();
    return { local, public: pub };
});

ipcMain.handle('server:setPassword', async (event, pwd) => {
    if (!pwd || typeof pwd !== 'string') return { ok: false, error: 'Mot de passe invalide' };
    serverPassword = pwd;
    config.save({ serverPassword: pwd });
    // Restart the server with the new password
    try {
        serverHost.stopServer();
        await new Promise(r => setTimeout(r, 800));
        serverHost.startServer({ port: 5026, password: serverPassword });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.on('server:openLogs', () => showServerLogs());
ipcMain.handle('app:quit', () => { app.quit(); });

// ---- Updater IPC ---------------------------------------------------------
ipcMain.handle('updater:check', () => autoUpdater.checkForUpdates());
ipcMain.handle('updater:download', () => autoUpdater.downloadUpdate());
ipcMain.on('updater:quitAndInstall', () => autoUpdater.quitAndInstall());

// Forward progress events to the splash window
autoUpdater.onProgress((pct) => {
    if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.webContents.send('updater:progress', pct);
    }
});

// ----------------------------------------------------------------------------
// Maps library window
// ----------------------------------------------------------------------------
function createMapsWindow() {
    if (mapsWindow && !mapsWindow.isDestroyed()) {
        mapsWindow.focus();
        return;
    }
    mapsWindow = new BrowserWindow({
        width: 980, height: 720,
        minWidth: 760, minHeight: 500,
        autoHideMenuBar: true,
        backgroundColor: '#0a1012',
        title: 'MCL-SIT — Bibliothèque de cartes',
        icon: resolveIconPath() || undefined,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true, sandbox: true, nodeIntegration: false,
            devTools: !app.isPackaged
        }
    });
    mapsWindow.setMenu(null);
    mapsWindow.loadFile(path.join(__dirname, 'maps-window.html'));
    mapsWindow.once('ready-to-show', () => mapsWindow.show());
    mapsWindow.on('closed', () => { mapsWindow = null; });
}

// Maps IPC
ipcMain.handle('maps:list', () => mapsLibrary.listMaps());
ipcMain.handle('maps:getThumbnail', (e, id) => mapsLibrary.getThumbnail(id));
ipcMain.handle('maps:getImage', (e, id) => mapsLibrary.getMapImage(id));
ipcMain.handle('maps:add', (e, sourcePath, meta) => {
    try {
        const entry = mapsLibrary.addMap(sourcePath, meta);
        return { ok: true, entry };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});
ipcMain.handle('maps:update', (e, id, patch) => {
    try {
        const entry = mapsLibrary.updateMap(id, patch);
        return { ok: true, entry };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});
ipcMain.handle('maps:delete', (e, id) => {
    try {
        return { ok: mapsLibrary.deleteMap(id) };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});
ipcMain.handle('maps:pickFile', async () => {
    const r = await dialog.showOpenDialog({
        title: 'Choisir une image de carte',
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
        properties: ['openFile']
    });
    if (r.canceled || !r.filePaths || r.filePaths.length === 0) return { path: null };
    const p = r.filePaths[0];
    return { path: p, name: path.basename(p) };
});
ipcMain.handle('maps:readAsDataURL', async (e, filePath) => {
    try {
        const buf = fs.readFileSync(filePath);
        const ext = path.extname(filePath).slice(1).toLowerCase();
        const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
                   : (ext === 'webp') ? 'image/webp'
                   : (ext === 'bmp') ? 'image/bmp'
                   : 'image/png';
        return { ok: true, dataURL: 'data:' + mime + ';base64,' + buf.toString('base64') };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});
ipcMain.handle('maps:load', (e, id) => {
    // Loading a map = sending it to the SIT renderer.
    // If the SIT window is open, just send the data.
    // If not, store as pending and launch the client mode so it picks it up on ready.
    const list = mapsLibrary.listMaps().maps;
    const m = list.find(x => x.id === id);
    if (!m) return { ok: false, error: 'Carte introuvable' };
    const dataURL = mapsLibrary.getMapImage(id);
    if (!dataURL) return { ok: false, error: 'Image illisible' };
    const payload = {
        id: m.id, name: m.name, dcsMap: m.dcsMap,
        cornerCoord: m.cornerCoord || '',
        widthKm: m.widthKm, heightKm: m.heightKm,
        imgWidth: m.imgWidth, imgHeight: m.imgHeight,
        dataURL: dataURL
    };
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('maps:loadMap', payload);
        mainWindow.focus();
        return { ok: true };
    }
    // SIT window not open — store as pending and launch client mode
    pendingMapLoad = payload;
    if (splashWindow) { splashWindow.close(); splashWindow = null; }
    launchMode('client');
    return { ok: true };
});

// Splash → open maps standalone
ipcMain.on('app:openMapsLibrary', () => {
    if (splashWindow) { splashWindow.close(); splashWindow = null; }
    createMapsWindow();
});

// When the SIT renderer signals it is ready, send any pending map
ipcMain.on('renderer:ready', (e) => {
    if (pendingMapLoad && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('maps:loadMap', pendingMapLoad);
        pendingMapLoad = null;
    }
});

// ----------------------------------------------------------------------------
// V18: Server maps relay — bridge between the SIT renderer (which owns the
// WebSocket connection) and the maps library window.
// ----------------------------------------------------------------------------
let serverConnState = { connected: false, host: null, port: null, name: null };
let serverMapsList = [];
// In-flight transfers
let pendingUploads = {};   // id -> { resolve, reject, name }
let pendingDownloads = {}; // id -> { resolve, reject, meta, chunks, expectedChunks }

function sendToMapsWindow(channel, payload) {
    if (mapsWindow && !mapsWindow.isDestroyed()) {
        mapsWindow.webContents.send(channel, payload);
    }
}

function sendToSITRenderer(payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('maps:sendWS', payload);
        return true;
    }
    return false;
}

// SIT renderer notifies us when its connection state changes
ipcMain.on('maps:notifyServerConnectionState', (e, state) => {
    serverConnState = state || { connected: false };
    if (!serverConnState.connected) serverMapsList = [];
    sendToMapsWindow('maps:serverConnectionState', serverConnState);
    if (!serverConnState.connected) sendToMapsWindow('maps:serverMapsList', []);
});

// SIT renderer forwards incoming serverMapsList from the WebSocket
ipcMain.on('maps:serverMapsListReceived', (e, list) => {
    serverMapsList = Array.isArray(list) ? list : [];
    sendToMapsWindow('maps:serverMapsList', serverMapsList);
});

// SIT renderer forwards mapUploadResult
ipcMain.on('maps:mapUploadResultReceived', (e, msg) => {
    const id = msg && msg.id;
    if (!id) return;
    const slot = pendingUploads[id];
    if (!slot) return;
    delete pendingUploads[id];
    if (msg.ok) slot.resolve({ ok: true });
    else slot.resolve({ ok: false, error: msg.error || 'erreur serveur' });
});

// SIT renderer forwards mapDeleteResult
ipcMain.on('maps:mapDeleteResultReceived', (e, msg) => {
    const id = msg && msg.id;
    if (!id) return;
    const slot = pendingUploads[id]; // we reuse pendingUploads for delete waits
    if (!slot) return;
    delete pendingUploads[id];
    if (msg.ok) slot.resolve({ ok: true });
    else slot.resolve({ ok: false, error: msg.error || 'erreur serveur' });
});

// SIT renderer forwards mapDownload* events
ipcMain.on('maps:mapDownloadMsgReceived', (e, msg) => {
    const id = msg && msg.id;
    if (!id) return;
    const slot = pendingDownloads[id];
    if (!slot) return;
    if (msg.type === 'mapDownloadStart') {
        slot.meta = msg.meta;
        slot.expectedChunks = msg.totalChunks;
        slot.chunks = new Array(msg.totalChunks);
        slot.receivedChunks = 0;
    } else if (msg.type === 'mapDownloadChunk') {
        try {
            slot.chunks[msg.index] = Buffer.from(msg.data, 'base64');
            slot.receivedChunks++;
            if (slot.expectedChunks > 0) {
                const pct = Math.round(slot.receivedChunks * 100 / slot.expectedChunks);
                sendToMapsWindow('maps:downloadProgress', { id: id, pct: pct });
            }
        } catch (err) {}
    } else if (msg.type === 'mapDownloadEnd') {
        delete pendingDownloads[id];
        try {
            const full = Buffer.concat(slot.chunks.filter(Boolean));
            // Save into the local library
            const meta = slot.meta;
            const tmpFile = path.join(app.getPath('temp'), 'mclsit-dl-' + id + '.bin');
            fs.writeFileSync(tmpFile, full);
            // Generate a thumbnail data URL: use the meta.thumbDataURL if provided by uploader
            const entry = mapsLibrary.addMap(tmpFile, {
                name: meta.name,
                dcsMap: meta.dcsMap,
                cornerCoord: meta.cornerCoord,
                widthKm: meta.widthKm,
                heightKm: meta.heightKm,
                imgWidth: meta.imgWidth,
                imgHeight: meta.imgHeight,
                thumbnailDataURL: meta.thumbDataURL
            });
            try { fs.unlinkSync(tmpFile); } catch (err) {}
            slot.resolve({ ok: true, entry });
        } catch (err) {
            slot.resolve({ ok: false, error: err.message });
        }
    } else if (msg.type === 'mapDownloadError') {
        delete pendingDownloads[id];
        slot.resolve({ ok: false, error: msg.error || 'erreur serveur' });
    }
});

// Maps library asks for current state
ipcMain.handle('maps:getServerConnectionState', () => serverConnState);
ipcMain.handle('maps:getServerMapsList', () => serverMapsList);

// Maps library asks to publish a local map
ipcMain.handle('maps:publishToServer', async (e, id) => {
    if (!serverConnState.connected) return { ok: false, error: 'Pas connecté au serveur SIT' };
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'SIT non lancé' };
    // Load the local map
    const local = mapsLibrary.listMaps().maps.find(x => x.id === id);
    if (!local) return { ok: false, error: 'Carte locale introuvable' };
    let buf;
    try { buf = fs.readFileSync(local.imagePath); }
    catch (err) { return { ok: false, error: 'Lecture image échouée : ' + err.message }; }

    const ext = path.extname(local.imagePath).slice(1).toLowerCase();
    const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
               : (ext === 'webp') ? 'image/webp'
               : 'image/png';
    const thumbDataURL = mapsLibrary.getThumbnail(id);

    const CHUNK = 64 * 1024;
    const totalChunks = Math.ceil(buf.length / CHUNK);

    return new Promise((resolve) => {
        pendingUploads[id] = { resolve, name: local.name };
        const okStart = sendToSITRenderer({
            type: 'mapUploadStart',
            meta: {
                id: id,
                name: local.name,
                dcsMap: local.dcsMap,
                cornerCoord: local.cornerCoord || '',
                widthKm: local.widthKm,
                heightKm: local.heightKm,
                imgWidth: local.imgWidth,
                imgHeight: local.imgHeight,
                sizeBytes: buf.length,
                mime: mime,
                thumbDataURL: thumbDataURL
            },
            totalChunks: totalChunks
        });
        if (!okStart) {
            delete pendingUploads[id];
            resolve({ ok: false, error: 'SIT non joignable' });
            return;
        }
        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK;
            const end = Math.min(start + CHUNK, buf.length);
            const slice = buf.slice(start, end);
            sendToSITRenderer({
                type: 'mapUploadChunk',
                id: id,
                index: i,
                data: slice.toString('base64')
            });
            const pct = Math.round((i + 1) * 100 / totalChunks);
            sendToMapsWindow('maps:uploadProgress', { id: id, pct: pct });
        }
        sendToSITRenderer({ type: 'mapUploadEnd', id: id });
        // Timeout if no response in 30s
        setTimeout(() => {
            if (pendingUploads[id]) {
                delete pendingUploads[id];
                resolve({ ok: false, error: 'Pas de réponse du serveur (timeout)' });
            }
        }, 30000);
    });
});

// Maps library asks to download a server map
ipcMain.handle('maps:downloadFromServer', async (e, id) => {
    if (!serverConnState.connected) return { ok: false, error: 'Pas connecté' };
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'SIT non lancé' };
    return new Promise((resolve) => {
        pendingDownloads[id] = { resolve, chunks: [], expectedChunks: 0, receivedChunks: 0 };
        sendToSITRenderer({ type: 'mapDownloadRequest', id: id });
        setTimeout(() => {
            if (pendingDownloads[id]) {
                delete pendingDownloads[id];
                resolve({ ok: false, error: 'Timeout' });
            }
        }, 60000);
    });
});

// Maps library asks to delete a server map (owner only)
ipcMain.handle('maps:deleteFromServer', async (e, id) => {
    if (!serverConnState.connected) return { ok: false, error: 'Pas connecté' };
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'SIT non lancé' };
    return new Promise((resolve) => {
        pendingUploads[id] = { resolve };
        sendToSITRenderer({ type: 'mapDelete', id: id });
        setTimeout(() => {
            if (pendingUploads[id]) {
                delete pendingUploads[id];
                resolve({ ok: false, error: 'Timeout' });
            }
        }, 10000);
    });
});

// ----------------------------------------------------------------------------
// V18 : Capture window + Python setup
// ----------------------------------------------------------------------------
let captureWindow = null;

function createCaptureWindow() {
    if (captureWindow && !captureWindow.isDestroyed()) {
        captureWindow.focus();
        return;
    }
    captureWindow = new BrowserWindow({
        width: 880, height: 760,
        minWidth: 720, minHeight: 600,
        autoHideMenuBar: true,
        backgroundColor: '#0a1012',
        title: 'MCL-SIT — Capture de carte',
        icon: resolveIconPath() || undefined,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true, sandbox: true, nodeIntegration: false,
            devTools: !app.isPackaged
        }
    });
    captureWindow.setMenu(null);
    captureWindow.loadFile(path.join(__dirname, 'capture-window.html'));
    captureWindow.once('ready-to-show', () => captureWindow.show());
    captureWindow.on('closed', () => { captureWindow = null; });
}

ipcMain.on('app:openCaptureWindow', () => createCaptureWindow());

ipcMain.handle('capture:checkPython', () => ({ ok: pythonSetup.isInstalled() }));

ipcMain.handle('capture:setupPython', async (e) => {
    return await pythonSetup.setup((info) => {
        if (captureWindow && !captureWindow.isDestroyed()) {
            captureWindow.webContents.send('capture:setupProgress', info);
        }
    });
});

ipcMain.handle('capture:run', async (e, params) => {
    return await captureRunner.runCapture(params, (line) => {
        if (captureWindow && !captureWindow.isDestroyed()) {
            captureWindow.webContents.send('capture:log', line);
        }
    });
});

ipcMain.handle('capture:cancel', () => {
    captureRunner.cancelCapture();
    return { ok: true };
});

ipcMain.handle('capture:saveToLibrary', async (e, opts) => {
    try {
        if (!opts.finalImage || !fs.existsSync(opts.finalImage)) {
            return { ok: false, error: 'Image finale introuvable' };
        }
        // Read image dims via a small probe — Electron's nativeImage can decode
        const { nativeImage } = require('electron');
        const img = nativeImage.createFromPath(opts.finalImage);
        const sz = img.getSize();
        // Make a 256x256 thumbnail with cover fit
        const thumbSz = 256;
        const scale = Math.max(thumbSz / sz.width, thumbSz / sz.height);
        const tw = Math.round(sz.width * scale);
        const th = Math.round(sz.height * scale);
        const resized = img.resize({ width: tw, height: th });
        const thumbDataURL = resized.toDataURL();
        const entry = mapsLibrary.addMap(opts.finalImage, {
            name: opts.name,
            dcsMap: opts.dcsMap,
            cornerCoord: opts.cornerCoord,
            widthKm: opts.widthKm,
            heightKm: opts.heightKm,
            imgWidth: sz.width,
            imgHeight: sz.height,
            thumbnailDataURL: thumbDataURL
        });
        // Also remove the final source file (we have a copy in the library)
        try { fs.unlinkSync(opts.finalImage); } catch (e) {}
        // V18.1 — notify the maps library window (if open) to refresh
        if (mapsWindow && !mapsWindow.isDestroyed()) {
            mapsWindow.webContents.send('maps:localLibraryChanged');
        }
        return { ok: true, entry };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('capture:cleanupIntermediates', (e, paths) => {
    return captureRunner.cleanupIntermediates(paths);
});

ipcMain.on('capture:openFolder', (e, folder) => {
    if (folder && fs.existsSync(folder)) {
        shell.openPath(folder);
    }
});

// ----------------------------------------------------------------------------
// Lifecycle
// ----------------------------------------------------------------------------
app.whenReady().then(() => {
    const cfg = config.load();
    config.save({ lastVersion: app.getVersion() });
    if (cfg.serverPassword) serverPassword = cfg.serverPassword;
    if (cfg.rememberMode && cfg.mode) {
        launchMode(cfg.mode);
    } else {
        createSplashWindow();
    }
});

app.on('second-instance', () => {
    const w = serverWindow || mainWindow || mapsWindow || splashWindow;
    if (w) {
        if (w.isMinimized()) w.restore();
        w.focus();
    }
});

app.on('window-all-closed', () => {
    app.quit();
});

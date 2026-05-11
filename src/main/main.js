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

logger.init();

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

let splashWindow = null;
let mainWindow = null;
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
    const w = serverWindow || mainWindow || splashWindow;
    if (w) {
        if (w.isMinimized()) w.restore();
        w.focus();
    }
});

app.on('window-all-closed', () => {
    app.quit();
});

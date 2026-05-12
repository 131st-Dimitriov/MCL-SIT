// =============================================================================
// MCL-SIT — Custom Auto-Updater
// =============================================================================
// We use Inno Setup to build the installer (so we can keep the 2 DCS checkboxes
// and firewall rules). electron-updater only knows how to update NSIS/Squirrel
// installers, so we roll our own simple update flow:
//
//   1. Query GitHub Releases API for the latest tag
//   2. If version > current, propose the user to download
//   3. Download the .exe (the Inno setup) to a temp folder
//   4. Spawn the installer with /SILENT or default arguments
//   5. Quit the app — Inno will replace it and (optionally) relaunch
//
// Configuration: GitHub owner + repo are hardcoded here for security
// (so an obfuscated/redistributed app can't be redirected to a malicious source).
// =============================================================================

const { app, net: electronNet, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('./logger');

const GH_OWNER = '131st-Dimitriov';
const GH_REPO = 'MCL-SIT';

let state = {
    checking: false,
    hasUpdate: false,
    currentVersion: app.getVersion(),
    latestVersion: null,
    downloadUrl: null,
    downloadProgress: 0,
    downloadPath: null,
    error: null
};

const listeners = { progress: new Set() };

function emit(type, payload) {
    for (const fn of listeners[type] || []) {
        try { fn(payload); } catch (e) { logger.error('updater listener', e); }
    }
}

// ----------------------------------------------------------------------------
// HTTP helper using Electron's net module (no extra deps; respects proxy)
// ----------------------------------------------------------------------------
function httpGet(url, headers) {
    return new Promise((resolve, reject) => {
        const req = electronNet.request({
            method: 'GET',
            url: url,
            redirect: 'follow'
        });
        for (const [k, v] of Object.entries(headers || {})) req.setHeader(k, v);
        const chunks = [];
        req.on('response', (resp) => {
            resp.on('data', (c) => chunks.push(c));
            resp.on('end', () => resolve({ statusCode: resp.statusCode, body: Buffer.concat(chunks) }));
            resp.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}

function httpDownload(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(destPath);
        const req = electronNet.request({ method: 'GET', url: url, redirect: 'follow' });
        let received = 0;
        let total = 0;
        req.on('response', (resp) => {
            if (resp.statusCode !== 200) {
                fileStream.close();
                try { fs.unlinkSync(destPath); } catch (e) {}
                return reject(new Error('HTTP ' + resp.statusCode));
            }
            total = parseInt(resp.headers['content-length'] || resp.headers['Content-Length'] || '0', 10);
            resp.on('data', (chunk) => {
                fileStream.write(chunk);
                received += chunk.length;
                if (total > 0 && onProgress) onProgress(Math.round(received * 100 / total));
            });
            resp.on('end', () => {
                fileStream.end();
                fileStream.on('close', () => resolve(destPath));
            });
            resp.on('error', (e) => { fileStream.close(); reject(e); });
        });
        req.on('error', reject);
        req.end();
    });
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

function compareSemver(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
        const ai = pa[i] || 0, bi = pb[i] || 0;
        if (ai > bi) return 1;
        if (ai < bi) return -1;
    }
    return 0;
}

async function checkForUpdates() {
    if (!app.isPackaged) {
        logger.log('[updater] skipping check (dev mode)');
        return { hasUpdate: false, currentVersion: state.currentVersion, devMode: true };
    }
    if (state.checking) {
        return { hasUpdate: state.hasUpdate, currentVersion: state.currentVersion, latestVersion: state.latestVersion, error: state.error };
    }
    state.checking = true;
    state.error = null;
    try {
        const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/latest`;
        logger.log('[updater] GET ' + url);
        const resp = await httpGet(url, {
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'MCL-SIT-Updater/' + state.currentVersion
        });
        if (resp.statusCode === 404) {
            // No published release yet — normal early-stage situation.
            state.checking = false;
            logger.log('[updater] no release found (404) — assuming up-to-date');
            return { hasUpdate: false, currentVersion: state.currentVersion, latestVersion: null, error: null };
        }
        if (resp.statusCode !== 200) {
            state.checking = false;
            state.error = 'HTTP ' + resp.statusCode;
            logger.log('[updater] check failed: ' + state.error);
            return { hasUpdate: false, currentVersion: state.currentVersion, latestVersion: null, error: state.error };
        }
        const json = JSON.parse(resp.body.toString('utf8'));
        // tag_name like "v16.0.1" or "16.0.1" — strip leading 'v'
        const tag = (json.tag_name || '').replace(/^v/i, '');
        state.latestVersion = tag || null;
        state.hasUpdate = !!(tag && compareSemver(tag, state.currentVersion) > 0);
        // Locate the .exe asset (the Inno installer artifact name pattern is MCL-SIT-Setup-X.Y.Z.exe)
        if (state.hasUpdate && Array.isArray(json.assets)) {
            const asset = json.assets.find(a => /MCL-SIT-Setup-.*\.exe$/i.test(a.name));
            if (asset) {
                state.downloadUrl = asset.browser_download_url;
            } else {
                logger.log('[updater] WARN no MCL-SIT-Setup-*.exe asset in release ' + tag);
                state.error = 'Aucun installeur trouvé dans la release ' + tag;
            }
        }
        state.checking = false;
        logger.log('[updater] check OK: current=' + state.currentVersion + ' latest=' + tag + ' hasUpdate=' + state.hasUpdate);
        return {
            hasUpdate: state.hasUpdate,
            currentVersion: state.currentVersion,
            latestVersion: state.latestVersion,
            downloadUrl: state.downloadUrl,
            error: state.error
        };
    } catch (err) {
        state.checking = false;
        state.error = (err && err.message) || String(err);
        logger.error('[updater] check failed', err);
        return { hasUpdate: false, currentVersion: state.currentVersion, latestVersion: null, error: state.error };
    }
}

async function downloadUpdate() {
    if (!state.hasUpdate || !state.downloadUrl) {
        throw new Error('Aucune mise à jour disponible');
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mclsit-upd-'));
    const dest = path.join(tmp, 'MCL-SIT-Setup-' + state.latestVersion + '.exe');
    logger.log('[updater] downloading ' + state.downloadUrl + ' -> ' + dest);
    await httpDownload(state.downloadUrl, dest, (pct) => {
        state.downloadProgress = pct;
        emit('progress', pct);
    });
    state.downloadPath = dest;
    logger.log('[updater] downloaded to ' + dest + ' (' + fs.statSync(dest).size + ' bytes)');
    return dest;
}

function quitAndInstall() {
    if (!state.downloadPath || !fs.existsSync(state.downloadPath)) {
        logger.log('[updater] quitAndInstall called but no downloaded file');
        return;
    }
    logger.log('[updater] launching installer ' + state.downloadPath);
    // Inno setup default behavior: shows the wizard. We don't pass /SILENT here
    // so the user can confirm DCS folders / firewall again (in case they changed).
    // detached:true lets the installer outlive our app's quit.
    try {
        const child = spawn(state.downloadPath, [], {
            detached: true,
            stdio: 'ignore',
            windowsHide: false
        });
        child.unref();
    } catch (e) {
        logger.error('[updater] spawn installer failed', e);
        // Fall back to opening with the OS shell
        shell.openPath(state.downloadPath);
    }
    // Quit the app to let the installer replace files
    setTimeout(() => app.quit(), 400);
}

function onProgress(fn) {
    listeners.progress.add(fn);
    return () => listeners.progress.delete(fn);
}

function getState() { return Object.assign({}, state); }

module.exports = {
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    onProgress,
    getState
};

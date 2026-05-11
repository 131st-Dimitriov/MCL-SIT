// =============================================================================
// MCL-SIT — Hook DCS checker
// =============================================================================
// At every launch we compare the hash of the installed hook (in DCS Saved Games)
// with the hash of the hook bundled in the app. If they diverge, the UI can
// propose to update the installed copy without re-running the installer.
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const config = require('./config');

// Resolve the bundled hook location.
// In dev: src/lua/SIT_WorldHook.lua
// In packaged: extraResources at <app-root>/resources/lua/SIT_WorldHook.lua
function getBundledHookPath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'lua', 'SIT_WorldHook.lua');
    }
    return path.join(__dirname, '..', 'lua', 'SIT_WorldHook.lua');
}

function getInstalledHookPath() {
    const cfg = config.load();
    if (!cfg.dcsHookPath) return null;
    // dcsHookPath is the Scripts/Hooks/ folder (chosen at install)
    return path.join(cfg.dcsHookPath, 'SIT_WorldHook.lua');
}

function hashFile(p) {
    if (!fs.existsSync(p)) return null;
    const buf = fs.readFileSync(p);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function getStatus() {
    // Returns: 'unconfigured' | 'missing' | 'ok' | 'outdated' | 'error'
    const bundled = getBundledHookPath();
    if (!fs.existsSync(bundled)) return 'error'; // app is broken — should not happen
    const installed = getInstalledHookPath();
    if (!installed) return 'unconfigured';
    if (!fs.existsSync(installed)) return 'missing';
    const hBundled = hashFile(bundled);
    const hInstalled = hashFile(installed);
    if (hBundled === hInstalled) return 'ok';
    return 'outdated';
}

function updateInstalledHook() {
    const bundled = getBundledHookPath();
    const installed = getInstalledHookPath();
    if (!installed) return { ok: false, reason: 'no dcsHookPath configured' };
    try {
        fs.mkdirSync(path.dirname(installed), { recursive: true });
        fs.copyFileSync(bundled, installed);
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: err.message };
    }
}

module.exports = { getStatus, updateInstalledHook, getBundledHookPath, getInstalledHookPath };

// =============================================================================
// MCL-SIT — Config persistence
// =============================================================================
// Stores user choices (mode, server IP, etc.) in %APPDATA%\MCL-SIT\config.json.
// Persistent across app updates (electron-builder preserves userData).
// =============================================================================

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

const DEFAULTS = {
    mode: null,              // null | 'client' | 'server' | 'both'
    rememberMode: false,     // if true, skip the splash on next launch
    serverHost: '127.0.0.1', // for client mode
    serverPort: 5026,
    dcsHookPath: null,       // chosen at install time, stored for hook update detection
    lastVersion: null        // last version that ran — used to detect upgrades
};

let cached = null;

function load() {
    if (cached) return cached;
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
            cached = Object.assign({}, DEFAULTS, JSON.parse(raw));
        } else {
            cached = Object.assign({}, DEFAULTS);
        }
    } catch (err) {
        console.error('Config load failed, using defaults:', err);
        cached = Object.assign({}, DEFAULTS);
    }
    return cached;
}

function save(patch) {
    const cur = load();
    cached = Object.assign({}, cur, patch || {});
    try {
        fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cached, null, 2), 'utf8');
    } catch (err) {
        console.error('Config save failed:', err);
    }
    return cached;
}

function reset() {
    cached = Object.assign({}, DEFAULTS);
    try { fs.unlinkSync(CONFIG_FILE); } catch (e) {}
}

module.exports = { load, save, reset };

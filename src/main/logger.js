// =============================================================================
// MCL-SIT — File logger
// =============================================================================
// Mirrors console output to %APPDATA%\MCL-SIT\app.log
// Useful for diagnosing problems in packaged builds (no console visible).
// =============================================================================

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let logFile = null;
let stream = null;

function init() {
    try {
        const dir = app.getPath('userData');
        fs.mkdirSync(dir, { recursive: true });
        logFile = path.join(dir, 'app.log');
        // Truncate at 1 MB to avoid runaway growth
        try {
            const st = fs.statSync(logFile);
            if (st.size > 1024 * 1024) fs.unlinkSync(logFile);
        } catch (e) {}
        stream = fs.createWriteStream(logFile, { flags: 'a' });
        log('===== MCL-SIT started, version ' + app.getVersion() + ' =====');
        log('isPackaged=' + app.isPackaged + ' platform=' + process.platform + ' arch=' + process.arch);
        log('userData=' + dir);
        log('execPath=' + process.execPath);
        log('resourcesPath=' + (process.resourcesPath || '(undefined)'));
    } catch (err) {
        // If logging itself fails, console.error and move on — don't crash the app
        console.error('Logger init failed:', err);
    }
}

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    try { if (stream) stream.write(line + '\n'); } catch (e) {}
    console.log(line);
}

function error(msg, err) {
    const errStr = err ? (err.stack || err.message || String(err)) : '';
    log('ERROR: ' + msg + (errStr ? '\n' + errStr : ''));
}

function path_() { return logFile; }

module.exports = { init, log, error, path: path_ };

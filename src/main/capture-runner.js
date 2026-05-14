// =============================================================================
// MCL-SIT — Capture orchestrator (V18)
// =============================================================================
// Runs the Python capture/recalage flow in a subprocess and reports progress.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const pythonSetup = require('./python-setup');
const logger = require('./logger');

function getCaptureScriptsDir() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'capture');
    }
    return path.join(__dirname, '..', 'capture');
}

function getSessionsDir() {
    const d = path.join(app.getPath('userData'), 'captures');
    fs.mkdirSync(d, { recursive: true });
    return d;
}

let currentProc = null;

/**
 * Start a capture with given params.
 * params: { name, visibleKm, areaWidthKm, areaHeightKm (or 'square'), screenW, screenH }
 * onLog: callback(line) for stdout/stderr lines
 * Returns a promise resolved with { ok, finalImage, captureDir, recalageDir }.
 */
function runCapture(params, onLog) {
    onLog = onLog || (() => {});
    return new Promise((resolve, reject) => {
        if (currentProc) {
            return resolve({ ok: false, error: 'Une capture est déjà en cours' });
        }
        // Sanitize capture name
        const safeName = String(params.name || 'capture').replace(/[<>:"/\\|?*]/g, '_').substring(0, 80);
        const sessionDir = path.join(getSessionsDir(), safeName);

        const exe = pythonSetup.getPythonExe();
        if (!fs.existsSync(exe)) {
            return resolve({ ok: false, error: 'Python non installé' });
        }
        const wrapper = path.join(getCaptureScriptsDir(), 'capture_wrapper.py');
        if (!fs.existsSync(wrapper)) {
            return resolve({ ok: false, error: 'Script capture_wrapper.py introuvable' });
        }

        const heightArg = (params.areaHeightKm === 'square' || params.areaHeightKm === null || params.areaHeightKm === undefined)
            ? 'square' : String(params.areaHeightKm);

        const args = [
            wrapper,
            sessionDir,
            String(params.visibleKm),
            String(params.areaWidthKm),
            heightArg,
            String(params.screenW),
            String(params.screenH)
        ];

        logger.log('[capture] spawn ' + exe + ' ' + args.join(' '));
        onLog('[orchestrator] Lancement: ' + path.basename(exe) + ' capture_wrapper.py');
        onLog('[orchestrator] Session: ' + sessionDir);

        const env = Object.assign({}, process.env, {
            PYTHONIOENCODING: 'utf-8',
            PYTHONUNBUFFERED: '1'
        });

        let captured = '';
        let finalImage = null;

        try {
            currentProc = spawn(exe, args, {
                cwd: getCaptureScriptsDir(),
                env: env,
                windowsHide: false  // capture controls the screen — give it normal visibility
            });
        } catch (err) {
            return resolve({ ok: false, error: 'Spawn échoué: ' + err.message });
        }

        let stdoutBuf = '';
        let resultMeta = null;
        currentProc.stdout.on('data', (data) => {
            stdoutBuf += data.toString('utf8');
            let idx;
            while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
                const line = stdoutBuf.slice(0, idx).replace(/\r$/, '');
                stdoutBuf = stdoutBuf.slice(idx + 1);
                onLog(line);
                const m = line.match(/^\[wrapper\] RESULT (.+)$/);
                if (m) {
                    try {
                        resultMeta = JSON.parse(m[1]);
                        if (resultMeta.final_image) finalImage = resultMeta.final_image;
                    } catch (e) {}
                }
            }
        });
        let stderrBuf = '';
        currentProc.stderr.on('data', (data) => {
            stderrBuf += data.toString('utf8');
            let idx;
            while ((idx = stderrBuf.indexOf('\n')) >= 0) {
                const line = stderrBuf.slice(0, idx).replace(/\r$/, '');
                stderrBuf = stderrBuf.slice(idx + 1);
                onLog('[stderr] ' + line);
            }
        });
        currentProc.on('error', (err) => {
            currentProc = null;
            resolve({ ok: false, error: err.message });
        });
        currentProc.on('exit', (code) => {
            currentProc = null;
            if (code === 0 && finalImage && fs.existsSync(finalImage)) {
                resolve({
                    ok: true,
                    finalImage: finalImage,
                    intermediatePaths: (resultMeta && resultMeta.intermediate_paths) || [],
                    intermediateBytes: (resultMeta && resultMeta.intermediate_bytes) || 0
                });
            } else {
                resolve({ ok: false, error: 'Sortie code=' + code + (finalImage ? '' : ' (image finale introuvable)') });
            }
        });
    });
}

function cancelCapture() {
    if (currentProc) {
        try { currentProc.kill('SIGTERM'); } catch (e) {}
        setTimeout(() => { try { currentProc && currentProc.kill('SIGKILL'); } catch (e) {} }, 2000);
    }
}

function isRunning() { return currentProc !== null; }

/**
 * Remove the intermediate folders left by a capture (the tile folder and the
 * _recalage folder). Returns { ok, freed }.
 */
function cleanupIntermediates(paths) {
    let freed = 0;
    for (const p of paths || []) {
        if (!p) continue;
        try {
            if (fs.existsSync(p)) {
                // Compute size before deleting
                freed += folderSize(p);
                fs.rmSync(p, { recursive: true, force: true });
                logger.log('[capture] cleaned ' + p);
            }
        } catch (err) {
            logger.error('[capture] cleanup failed for ' + p, err);
        }
    }
    return { ok: true, freed };
}

function folderSize(p) {
    if (!fs.existsSync(p)) return 0;
    let total = 0;
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else { try { total += fs.statSync(full).size; } catch (er) {} }
        }
    };
    try { walk(p); } catch (e) {}
    return total;
}

module.exports = {
    runCapture,
    cancelCapture,
    isRunning,
    cleanupIntermediates,
    getSessionsDir
};

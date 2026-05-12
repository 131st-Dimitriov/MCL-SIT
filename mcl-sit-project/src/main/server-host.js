// =============================================================================
// MCL-SIT — Server host
// =============================================================================
// Spawns sit-multi.js as a child process and parses snapshots emitted on stdout.
// =============================================================================

const { fork } = require('child_process');
const path = require('path');
const { app } = require('electron');
const EventEmitter = require('events');
const logger = require('./logger');

const emitter = new EventEmitter();
let serverProcess = null;
let serverLog = [];
let lastSnapshot = { clients: [], count: 0, port: 5026 };
const MAX_LOG_LINES = 500;
const SNAPSHOT_PREFIX = '@@MCLSIT_SNAPSHOT@@';

function appendLog(line) {
    serverLog.push(`[${new Date().toISOString()}] ${line}`);
    if (serverLog.length > MAX_LOG_LINES) serverLog.shift();
}

function startServer(options) {
    if (serverProcess) {
        appendLog('startServer called but server is already running, ignoring');
        return;
    }
    const opts = options || {};
    const port = opts.port || 5026;
    const password = opts.password || 'Scramble';

    // Resolve the script path. Critical: when packaged, src/server is in app.asar.unpacked,
    // NOT in app.asar, because spawn() cannot execute files from inside an asar archive.
    // electron-builder mirrors the structure to app.asar.unpacked when asarUnpack matches.
    const fs = require('fs');
    let scriptPath = path.join(__dirname, '..', 'server', 'sit-multi.js');
    if (scriptPath.includes('app.asar' + path.sep)) {
        const unpacked = scriptPath.replace(
            'app.asar' + path.sep,
            'app.asar.unpacked' + path.sep
        );
        if (fs.existsSync(unpacked)) {
            scriptPath = unpacked;
        } else {
            appendLog('WARN: expected unpacked script at ' + unpacked + ' but not found');
        }
    }
    appendLog('Spawning sit-multi.js from: ' + scriptPath + ' (port=' + port + ')');
    logger.log('server-host: scriptPath=' + scriptPath);
    logger.log('server-host: scriptExists=' + fs.existsSync(scriptPath));
    logger.log('server-host: execPath=' + process.execPath);
    logger.log('server-host: execPathExists=' + fs.existsSync(process.execPath));

    try {
        const { spawn } = require('child_process');
        const execPath = process.execPath;
        const childEnv = {
            ...process.env,
            MCLSIT_SERVER: '1',
            ELECTRON_RUN_AS_NODE: '1'
        };
        delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
        delete childEnv.ATOM_SHELL_INTERNAL_RUN_AS_NODE;
        // CWD must also be on disk (not asar). Use the script's own folder.
        const cwd = path.dirname(scriptPath);
        logger.log('server-host: cwd=' + cwd);
        serverProcess = spawn(execPath, [scriptPath, '--port=' + port, '--password=' + password], {
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: cwd,
            env: childEnv,
            windowsHide: true
        });

        let stdoutBuf = '';
        serverProcess.stdout.on('data', (data) => {
            stdoutBuf += data.toString();
            let idx;
            while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
                const line = stdoutBuf.slice(0, idx).replace(/\r$/, '');
                stdoutBuf = stdoutBuf.slice(idx + 1);
                handleStdoutLine(line);
            }
        });
        serverProcess.stderr.on('data', (data) => {
            const txt = data.toString().trimEnd();
            txt.split('\n').forEach(line => appendLog('[ERR] ' + line));
        });
        serverProcess.on('exit', (code, signal) => {
            appendLog(`Server process exited with code=${code} signal=${signal}`);
            logger.log('server-host: child exited code=' + code + ' signal=' + signal);
            serverProcess = null;
            emitter.emit('exit', { code, signal });
        });
        serverProcess.on('error', (err) => {
            appendLog('Server process error: ' + err.message);
            logger.error('server-host: child error', err);
            serverProcess = null;
        });
        appendLog('Server process spawned, pid=' + (serverProcess.pid || 'undefined'));
        logger.log('server-host: pid=' + (serverProcess.pid || 'undefined'));
    } catch (err) {
        appendLog('Failed to spawn server: ' + err.message);
        logger.error('server-host: spawn failed', err);
        serverProcess = null;
        throw err;
    }
}

function handleStdoutLine(line) {
    if (line.startsWith(SNAPSHOT_PREFIX)) {
        const json = line.slice(SNAPSHOT_PREFIX.length);
        try {
            const snap = JSON.parse(json);
            lastSnapshot = snap;
            emitter.emit('snapshot', snap);
        } catch (e) {
            appendLog('[ERR] Failed to parse snapshot: ' + e.message);
        }
    } else if (line.length > 0) {
        appendLog('[OUT] ' + line);
    }
}

function stopServer() {
    if (!serverProcess) return;
    appendLog('Stopping server (SIGTERM)');
    serverProcess.kill('SIGTERM');
    setTimeout(() => {
        if (serverProcess) {
            appendLog('Server did not exit, sending SIGKILL');
            try { serverProcess.kill('SIGKILL'); } catch (e) {}
        }
    }, 3000);
}

function isRunning() {
    return serverProcess !== null;
}

function getLogs() {
    return serverLog.slice();
}

function getSnapshot() {
    return lastSnapshot;
}

app.on('before-quit', () => {
    stopServer();
});

module.exports = {
    startServer,
    stopServer,
    isRunning,
    getLogs,
    getSnapshot,
    onSnapshot: (fn) => emitter.on('snapshot', fn),
    offSnapshot: (fn) => emitter.off('snapshot', fn),
    onExit: (fn) => emitter.on('exit', fn)
};

// =============================================================================
// MCL-SIT — Python bootstrap (V18)
// =============================================================================
// First time the user requests a capture, we set up an embedded Python in
// %APPDATA%\MCL-SIT\python\ :
//   1. Download python-3.11.x-embed-amd64.zip from python.org
//   2. Unzip into %APPDATA%\MCL-SIT\python\
//   3. Enable site-packages by editing python311._pth
//   4. Download get-pip.py and run it
//   5. Run python -m pip install -r requirements.txt
//
// On subsequent calls, we just verify everything is present and return immediately.
// =============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, net: electronNet } = require('electron');
const { spawn } = require('child_process');
const logger = require('./logger');

const PYTHON_VERSION = '3.11.9';
const PYTHON_EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

function getPythonDir() {
    return path.join(app.getPath('userData'), 'python');
}
function getPythonExe() {
    return path.join(getPythonDir(), 'python.exe');
}
function getScriptsDir() {
    return path.join(getPythonDir(), 'Scripts');
}
function getRequirementsPath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'capture', 'requirements.txt');
    }
    return path.join(__dirname, '..', 'capture', 'requirements.txt');
}

function isInstalled() {
    if (!fs.existsSync(getPythonExe())) return false;
    // Check that key packages exist by looking for the site-packages content
    const sitePackages = path.join(getPythonDir(), 'Lib', 'site-packages');
    if (!fs.existsSync(sitePackages)) return false;
    const requiredPkgs = ['cv2', 'numpy', 'PIL', 'pyautogui'];
    for (const pkg of requiredPkgs) {
        if (!fs.existsSync(path.join(sitePackages, pkg)) &&
            !fs.existsSync(path.join(sitePackages, pkg + '.py'))) {
            // pyautogui has slightly different layout
            const altPaths = fs.readdirSync(sitePackages).filter(n =>
                n.toLowerCase().startsWith(pkg.toLowerCase())
            );
            if (altPaths.length === 0) return false;
        }
    }
    return true;
}

function downloadToFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const req = electronNet.request({ method: 'GET', url: url, redirect: 'follow' });
        let received = 0, total = 0;
        req.on('response', (resp) => {
            if (resp.statusCode !== 200) {
                file.close();
                try { fs.unlinkSync(destPath); } catch (e) {}
                return reject(new Error('HTTP ' + resp.statusCode + ' for ' + url));
            }
            total = parseInt(resp.headers['content-length'] || '0', 10);
            resp.on('data', (chunk) => {
                file.write(chunk);
                received += chunk.length;
                if (total > 0 && onProgress) onProgress(Math.round(received * 100 / total));
            });
            resp.on('end', () => { file.end(); file.on('close', () => resolve(destPath)); });
            resp.on('error', (e) => { file.close(); reject(e); });
        });
        req.on('error', reject);
        req.end();
    });
}

function unzipTo(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        // Use PowerShell's Expand-Archive — present on all Windows 10+ machines
        const ps = spawn('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-Command', `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`
        ], { windowsHide: true });
        let err = '';
        ps.stderr.on('data', (d) => err += d.toString());
        ps.on('error', reject);
        ps.on('exit', (code) => {
            if (code === 0) resolve(); else reject(new Error('Expand-Archive failed (' + code + '): ' + err));
        });
    });
}

function patchPthFile(pythonDir) {
    // python311._pth needs to enable site-packages by uncommenting "import site"
    // and adding the Lib/site-packages path. Without this, pip installs work but
    // imports fail at runtime.
    const files = fs.readdirSync(pythonDir).filter(f => /^python\d+\._pth$/.test(f));
    if (files.length === 0) throw new Error('python._pth introuvable');
    const pth = path.join(pythonDir, files[0]);
    let content = fs.readFileSync(pth, 'utf8');
    // Uncomment "import site"
    content = content.replace(/^#\s*import site/m, 'import site');
    if (!/^import site/m.test(content)) content += '\nimport site\n';
    // Add Lib/site-packages line if absent
    if (!/Lib[\\/]site-packages/.test(content)) {
        content = 'Lib\\site-packages\n' + content;
    }
    fs.writeFileSync(pth, content, 'utf8');
}

function runPython(args, env) {
    return new Promise((resolve, reject) => {
        const exe = getPythonExe();
        const proc = spawn(exe, args, {
            cwd: getPythonDir(),
            env: Object.assign({}, process.env, env || {}),
            windowsHide: true
        });
        let stdout = '', stderr = '';
        proc.stdout.on('data', (d) => stdout += d.toString());
        proc.stderr.on('data', (d) => stderr += d.toString());
        proc.on('error', reject);
        proc.on('exit', (code) => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error('python exited code=' + code + '\n' + stderr));
        });
    });
}

/**
 * Install Python + requirements. Reports progress via callback.
 * cb({ phase, message, pct }) — phase is 'download_python' | 'extract' | 'pip_install' | 'pip_packages' | 'done'
 */
async function setup(progressCb) {
    progressCb = progressCb || (() => {});
    const pyDir = getPythonDir();
    fs.mkdirSync(pyDir, { recursive: true });

    if (isInstalled()) {
        progressCb({ phase: 'done', message: 'Python déjà installé', pct: 100 });
        return { ok: true, alreadyInstalled: true };
    }

    try {
        // 1. Download Python embeddable zip
        const zipPath = path.join(pyDir, 'python-embed.zip');
        if (!fs.existsSync(zipPath)) {
            progressCb({ phase: 'download_python', message: 'Téléchargement de Python ' + PYTHON_VERSION + '...', pct: 0 });
            await downloadToFile(PYTHON_EMBED_URL, zipPath, (pct) => {
                progressCb({ phase: 'download_python', message: 'Téléchargement Python ' + pct + '%', pct: pct });
            });
        }

        // 2. Unzip
        progressCb({ phase: 'extract', message: 'Extraction de Python...', pct: 50 });
        if (!fs.existsSync(getPythonExe())) {
            await unzipTo(zipPath, pyDir);
        }
        try { fs.unlinkSync(zipPath); } catch (e) {}

        // 3. Patch _pth
        patchPthFile(pyDir);

        // 4. Download get-pip.py
        const getPipPath = path.join(pyDir, 'get-pip.py');
        if (!fs.existsSync(getPipPath)) {
            progressCb({ phase: 'pip_install', message: 'Téléchargement de pip...', pct: 60 });
            await downloadToFile(GET_PIP_URL, getPipPath);
        }

        // 5. Run get-pip
        progressCb({ phase: 'pip_install', message: 'Installation de pip...', pct: 65 });
        await runPython([getPipPath, '--no-warn-script-location']);
        try { fs.unlinkSync(getPipPath); } catch (e) {}

        // 6. Install requirements
        const reqs = getRequirementsPath();
        if (!fs.existsSync(reqs)) {
            throw new Error('requirements.txt introuvable: ' + reqs);
        }
        progressCb({ phase: 'pip_packages', message: 'Installation des dépendances (~150 Mo, peut prendre 1-2 min)...', pct: 70 });
        await runPython(['-m', 'pip', 'install', '--no-warn-script-location', '-r', reqs]);

        progressCb({ phase: 'done', message: 'Python prêt !', pct: 100 });
        logger.log('[python-setup] OK');
        return { ok: true };
    } catch (err) {
        logger.error('[python-setup] FAILED', err);
        progressCb({ phase: 'error', message: 'Erreur : ' + err.message, pct: 0 });
        return { ok: false, error: err.message };
    }
}

module.exports = {
    getPythonDir,
    getPythonExe,
    isInstalled,
    setup
};

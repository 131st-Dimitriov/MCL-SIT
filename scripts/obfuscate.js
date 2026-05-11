// =============================================================================
// scripts/obfuscate.js
// =============================================================================
// electron-builder afterPack hook.
//
// electron-builder packs sources into resources/app.asar BEFORE this hook fires
// (the asar packing is part of the "pack" step itself). So we:
//   1. Extract resources/app.asar to a temp folder
//   2. Obfuscate the .js files in that temp folder
//   3. Repack the temp folder back into resources/app.asar
//   4. Delete the temp folder
//
// Uses @electron/asar (transitive dep of electron-builder, no extra install).
// =============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');

function walk(dir, ext, out) {
    out = out || [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, ext, out);
        else if (entry.isFile() && entry.name.endsWith(ext)) out.push(full);
    }
    return out;
}

function rmrf(p) {
    if (!fs.existsSync(p)) return;
    try { fs.rmSync(p, { recursive: true, force: true }); }
    catch (e) {
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
            for (const f of fs.readdirSync(p)) rmrf(path.join(p, f));
            fs.rmdirSync(p);
        } else fs.unlinkSync(p);
    }
}

exports.default = async function afterPack(context) {
    const appOut = context.appOutDir;
    const asarPath = path.join(appOut, 'resources', 'app.asar');

    if (!fs.existsSync(asarPath)) {
        console.log('[obfuscate] No app.asar found at ' + asarPath + ' — skipping.');
        return;
    }

    let asar;
    try { asar = require('@electron/asar'); }
    catch (e) {
        try { asar = require('asar'); }
        catch (e2) {
            console.error('[obfuscate] Could not load @electron/asar or asar.');
            throw e2;
        }
    }

    let JsObf;
    try { JsObf = require('javascript-obfuscator'); }
    catch (e) {
        console.error('[obfuscate] javascript-obfuscator not installed.');
        throw e;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mclsit-obf-'));
    console.log('[obfuscate] Extracting app.asar to ' + tmpDir);
    asar.extractAll(asarPath, tmpDir);

    const targets = [];
    targets.push(...walk(path.join(tmpDir, 'src', 'main'), '.js'));
    targets.push(...walk(path.join(tmpDir, 'src', 'server'), '.js'));

    console.log('[obfuscate] Obfuscating ' + targets.length + ' file(s)…');

    const options = {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.75,
        deadCodeInjection: true,
        deadCodeInjectionThreshold: 0.4,
        identifierNamesGenerator: 'hexadecimal',
        renameGlobals: false,
        renameProperties: false,
        selfDefending: false,
        splitStrings: true,
        splitStringsChunkLength: 6,
        stringArray: true,
        stringArrayEncoding: ['rc4'],
        stringArrayThreshold: 0.85,
        stringArrayWrappersCount: 2,
        stringArrayWrappersChainedCalls: true,
        stringArrayWrappersType: 'function',
        transformObjectKeys: true,
        unicodeEscapeSequence: false,
        target: 'node'
    };

    for (const file of targets) {
        try {
            const src = fs.readFileSync(file, 'utf8');
            const obfuscated = JsObf.obfuscate(src, options).getObfuscatedCode();
            fs.writeFileSync(file, obfuscated, 'utf8');
            const rel = path.relative(tmpDir, file);
            console.log('[obfuscate] OK ' + rel + ' (' + src.length + ' → ' + obfuscated.length + ' bytes)');
        } catch (err) {
            console.error('[obfuscate] FAILED on ' + file + ': ' + err.message);
            rmrf(tmpDir);
            throw err;
        }
    }

    console.log('[obfuscate] Repacking app.asar…');
    fs.unlinkSync(asarPath);
    await asar.createPackage(tmpDir, asarPath);
    rmrf(tmpDir);
    console.log('[obfuscate] Done. New app.asar size: ' + fs.statSync(asarPath).size + ' bytes');
};

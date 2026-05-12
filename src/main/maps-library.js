// =============================================================================
// MCL-SIT — Maps library (V17)
// =============================================================================
// Persists user-uploaded tactical maps under %APPDATA%\MCL-SIT\maps\.
// Each map has:
//   - id          : unique id (timestamp-based)
//   - name        : user-given name
//   - dcsMap      : DCS theatre (Caucase, Syrie, ...)
//   - dateAdded   : ISO timestamp
//   - imagePath   : full path to the copied image
//   - thumbPath   : full path to the 256x256 thumbnail
//   - widthKm     : map width in kilometers (real-world span)
//   - heightKm    : map height in kilometers
//   - imgWidth    : original image pixel width
//   - imgHeight   : original image pixel height
//   - refPoint    : { px, py, lat, lon } — calibration point
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const logger = require('./logger');

function getMapsDir() {
    const d = path.join(app.getPath('userData'), 'maps');
    fs.mkdirSync(d, { recursive: true });
    return d;
}
function getIndexPath() {
    return path.join(getMapsDir(), 'index.json');
}
function getThumbsDir() {
    const d = path.join(getMapsDir(), 'thumbs');
    fs.mkdirSync(d, { recursive: true });
    return d;
}

function loadIndex() {
    try {
        const p = getIndexPath();
        if (!fs.existsSync(p)) return [];
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
        logger.error('maps-library: loadIndex failed', e);
        return [];
    }
}

function saveIndex(list) {
    try {
        fs.writeFileSync(getIndexPath(), JSON.stringify(list, null, 2), 'utf8');
    } catch (e) {
        logger.error('maps-library: saveIndex failed', e);
        throw e;
    }
}

function genId() {
    return 'map_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function listMaps() {
    const list = loadIndex();
    // Add a "totalBytes" field that's nice for the UI
    let totalBytes = 0;
    for (const m of list) {
        try { totalBytes += fs.statSync(m.imagePath).size; } catch (e) {}
        try { totalBytes += fs.statSync(m.thumbPath).size; } catch (e) {}
    }
    return { maps: list, totalBytes: totalBytes };
}

/**
 * Add a new map.
 * sourcePath: absolute path to the source image on the user's disk
 * meta: { name, dcsMap, widthKm, heightKm, imgWidth, imgHeight, refPoint, thumbnailDataURL? }
 * Returns the newly-added map entry.
 */
function addMap(sourcePath, meta) {
    if (!fs.existsSync(sourcePath)) {
        throw new Error('Source image not found: ' + sourcePath);
    }
    const id = genId();
    const ext = path.extname(sourcePath).toLowerCase() || '.png';
    const destImage = path.join(getMapsDir(), id + ext);
    const destThumb = path.join(getThumbsDir(), id + '.png');

    fs.copyFileSync(sourcePath, destImage);

    // Write thumbnail if provided (data URL from renderer)
    if (meta.thumbnailDataURL && typeof meta.thumbnailDataURL === 'string') {
        const m = meta.thumbnailDataURL.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
        if (m) {
            try { fs.writeFileSync(destThumb, Buffer.from(m[2], 'base64')); }
            catch (e) { logger.error('thumbnail write failed', e); }
        }
    }

    const entry = {
        id: id,
        name: String(meta.name || 'Sans nom').slice(0, 200),
        dcsMap: String(meta.dcsMap || 'Autre'),
        cornerCoord: String(meta.cornerCoord || ''),
        dateAdded: new Date().toISOString(),
        imagePath: destImage,
        thumbPath: fs.existsSync(destThumb) ? destThumb : null,
        widthKm: Number(meta.widthKm) || 0,
        heightKm: Number(meta.heightKm) || 0,
        imgWidth: Number(meta.imgWidth) || 0,
        imgHeight: Number(meta.imgHeight) || 0,
        refPoint: meta.refPoint || null
    };

    const list = loadIndex();
    list.push(entry);
    saveIndex(list);
    logger.log('maps-library: added ' + entry.id + ' (' + entry.name + ')');
    return entry;
}

function updateMap(id, patch) {
    const list = loadIndex();
    const idx = list.findIndex(m => m.id === id);
    if (idx < 0) throw new Error('Map not found: ' + id);
    const allowed = ['name', 'dcsMap', 'cornerCoord', 'widthKm', 'heightKm', 'refPoint'];
    for (const k of allowed) {
        if (patch[k] !== undefined) list[idx][k] = patch[k];
    }
    saveIndex(list);
    logger.log('maps-library: updated ' + id);
    return list[idx];
}

function deleteMap(id) {
    const list = loadIndex();
    const idx = list.findIndex(m => m.id === id);
    if (idx < 0) return false;
    const m = list[idx];
    try { if (m.imagePath && fs.existsSync(m.imagePath)) fs.unlinkSync(m.imagePath); } catch (e) {}
    try { if (m.thumbPath && fs.existsSync(m.thumbPath)) fs.unlinkSync(m.thumbPath); } catch (e) {}
    list.splice(idx, 1);
    saveIndex(list);
    logger.log('maps-library: deleted ' + id);
    return true;
}

function getMapImage(id) {
    const list = loadIndex();
    const m = list.find(x => x.id === id);
    if (!m) return null;
    try {
        const buf = fs.readFileSync(m.imagePath);
        const ext = path.extname(m.imagePath).slice(1).toLowerCase();
        const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : 'image/png';
        return 'data:' + mime + ';base64,' + buf.toString('base64');
    } catch (e) {
        logger.error('maps-library: read image failed', e);
        return null;
    }
}

function getThumbnail(id) {
    const list = loadIndex();
    const m = list.find(x => x.id === id);
    if (!m || !m.thumbPath) return null;
    try {
        const buf = fs.readFileSync(m.thumbPath);
        return 'data:image/png;base64,' + buf.toString('base64');
    } catch (e) {
        return null;
    }
}

module.exports = {
    listMaps,
    addMap,
    updateMap,
    deleteMap,
    getMapImage,
    getThumbnail,
    getMapsDir
};

// ============================================================================
// DCS SIT V10 - Serveur Multi-joueur + Commander
// ============================================================================
// Lancement : node sit-multi-v6.js [--port=5026] [--password=Scramble]
//
// Compatible avec :
//   - Clients V5 (joueurs DCS avec bridge.js)
//   - Clients V6 Commander (HTML seul, pas de DCS)
//
// Lit sit_worldstate.json du hook SIT_WorldHook.lua pour fournir
// la vue complète du champ de bataille aux Commanders
// ============================================================================

const WebSocket = require('ws');
const fs = require('fs');
const dgram = require('dgram');
const path = require('path');
const os = require('os');

// ============================================================================
// CONFIGURATION
// ============================================================================
const args = process.argv.slice(2);
function getArg(name, def) {
    const a = args.find(x => x.startsWith('--' + name + '='));
    return a ? a.split('=')[1] : def;
}

const PORT = parseInt(getArg('port', '5026'));
const PASSWORD = getArg('password', 'Scramble');
const UDP_HOOK_PORT = 9089; // Réception worldstate/players depuis SIT_WorldHook.lua

const username = os.userInfo().username;
let dcsFolder = 'DCS';
const possibleFolders = ['DCS.dcs_serverrelease', 'DCS.openbeta', 'DCS'];
for (const folder of possibleFolders) {
    if (fs.existsSync(path.join('C:', 'Users', username, 'Saved Games', folder))) {
        dcsFolder = folder;
        break;
    }
}
const dcsBasePath = path.join('C:', 'Users', username, 'Saved Games', dcsFolder);

console.log('');
console.log('+------------------------------------------------------+');
console.log('|       DCS SIT V10 - Serveur Multi + Commander         |');
console.log('+------------------------------------------------------+');
console.log('|  V5 compatible + Worldstate pour Commander            |');
console.log('+------------------------------------------------------+');
console.log('');
console.log('  Port          : ' + PORT);
console.log('  Port UDP hook : ' + UDP_HOOK_PORT);
console.log('  Mot de passe  : ' + PASSWORD);
console.log('  DCS détecté   : ' + dcsFolder);
console.log('');

// ============================================================================
// ÉTAT DU SERVEUR
// ============================================================================
const clients = new Map();
let sharedDrawObjects = [];
let sharedTGTs = [];
let sharedDrones = [];
let refaltRequester = null; // WS of client who last requested REFALT
let sharedMarkers = [];
let sharedPlans = [];
// V15: PCDB reports — shared across all SIT clients, persisted server-side.
// Schema per entry: { id, lat, lon, text, author, timestamp, editedAt? }
let sharedPCDB = [];
// V18: shared maps pool. Each entry is metadata + chunks indexed by id.
// `sharedMapsMeta`  : array of { id, name, dcsMap, cornerCoord, widthKm, heightKm, imgWidth, imgHeight, author, timestamp, sizeBytes, thumbDataURL }
// `sharedMapsData`  : map<id, Buffer | { mime, base64 }> — the full map image, kept in memory only
let sharedMapsMeta = [];
let sharedMapsData = {};
// Upload state per client (assembling chunked uploads)
// uploadsInProgress[ws][id] = { meta, mime, expectedChunks, receivedChunks, buffers[] }
const uploadsInProgress = new WeakMap();
let lastWorldstate = null;

// ============================================================================
// SERVEUR WEBSOCKET
// ============================================================================
const wss = new WebSocket.Server({ port: PORT });

wss.on('listening', () => {
    console.log('  [OK] Serveur SIT V8 démarré sur le port ' + PORT);
    console.log('  En attente de connexions...');
    console.log('');
    // Emit initial empty snapshot for the parent window
    if (process.env.MCLSIT_SERVER === '1') {
        try { broadcastClientList(); } catch (e) {}
        // Heartbeat every 3s so the window can detect server liveness too
        setInterval(() => {
            if (process.env.MCLSIT_SERVER === '1') {
                try { broadcastClientList(); } catch (e) {}
            }
        }, 3000);
    }
});

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    console.log('  [+] Nouvelle connexion depuis ' + ip);
    
    clients.set(ws, { name: '', vehicle: '', coalition: '', authenticated: false, role: 'player' });
    
    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        
        const client = clients.get(ws);
        if (!client) return;
        
        // ---- AUTHENTIFICATION ----
        if (msg.type === 'auth') {
            if (msg.password !== PASSWORD) {
                ws.send(JSON.stringify({ type: 'authResult', success: false, reason: 'Mot de passe incorrect' }));
                return;
            }
            client.authenticated = true;
            client.name = (msg.name || 'Joueur').substring(0, 20);
            client.vehicle = (msg.vehicle || '').substring(0, 30);
            client.coalition = msg.coalition || 'blue';
            client.role = msg.role || 'player'; // 'player' ou 'commander'
            
            ws.send(JSON.stringify({ type: 'authResult', success: true }));
            
            // Envoyer l'état actuel
            ws.send(JSON.stringify({ type: 'drawSync', objects: sharedDrawObjects }));
            ws.send(JSON.stringify({ type: 'tgtSync', targets: sharedTGTs }));
            ws.send(JSON.stringify({ type: 'droneSync', drones: sharedDrones }));
            ws.send(JSON.stringify({ type: 'markerSync', markers: sharedMarkers }));
            ws.send(JSON.stringify({ type: 'planSync', plans: sharedPlans }));
            // V15: PCDB reports snapshot
            ws.send(JSON.stringify({ type: 'pcdbSync', reports: sharedPCDB }));
            // V18: also send the list of shared maps available on the server
            ws.send(JSON.stringify({ type: 'serverMapsList', maps: sharedMapsMeta }));
            
            // Commander reçoit la worldstate immédiatement
            if (client.role === 'commander' && lastWorldstate) {
                ws.send(JSON.stringify({ type: 'worldstate', units: lastWorldstate }));
            }
            // Send mods status if known
            if (modsStatus) {
                ws.send(JSON.stringify({ type: 'modsStatus', mods: modsStatus }));
            }
            
            broadcastClientList();
            const roleLabel = client.role === 'commander' ? ' [COMMANDER]' : '';
            console.log('  [[OK]] ' + client.name + ' authentifié (' + client.coalition + ')' + roleLabel);
            return;
        }
        
        if (!client.authenticated) return;
        
        // ---- DESSINS ----
        if (msg.type === 'drawAdd') {
            const obj = msg.object;
            if (!obj) return;
            obj._author = client.name;
            obj._coalition = client.coalition;
            obj._id = Date.now() + '_' + Math.random().toString(36).substr(2, 6);
            sharedDrawObjects.push(obj);
            broadcastExcept(ws, { type: 'drawAdd', object: obj });
            return;
        }
        if (msg.type === 'drawUndo') {
            for (let i = sharedDrawObjects.length - 1; i >= 0; i--) {
                if (sharedDrawObjects[i]._author === client.name) {
                    sharedDrawObjects.splice(i, 1);
                    break;
                }
            }
            broadcastAll({ type: 'drawSync', objects: sharedDrawObjects });
            return;
        }
        if (msg.type === 'drawClear') {
            if (msg.all) sharedDrawObjects = [];
            else sharedDrawObjects = sharedDrawObjects.filter(o => o._author !== client.name);
            broadcastAll({ type: 'drawSync', objects: sharedDrawObjects });
            return;
        }
        if (msg.type === 'drawDelete') {
            sharedDrawObjects = sharedDrawObjects.filter(o => o._id !== msg.id);
            broadcastAll({ type: 'drawSync', objects: sharedDrawObjects });
            return;
        }
        
        // ---- DRONES ----
        if (msg.type === 'droneUpdate') {
            const drones = msg.drones || [];
            sharedDrones = sharedDrones.filter(d => d.owner !== client.name);
            drones.forEach(d => {
                sharedDrones.push({
                    owner: client.name, coalition: client.coalition,
                    lat: d.lat, lon: d.lon, x: d.x, y: d.y,
                    heading: d.heading || 0,
                    revealed: d.revealed || [],
                    timestamp: Date.now()
                });
            });
            broadcastExcept(ws, { type: 'droneSync', drones: sharedDrones });
            return;
        }
        
        // ---- TGT ----
        if (msg.type === 'tgtAdd') {
            const tgt = msg.target;
            if (!tgt) return;
            tgt._author = client.name;
            tgt._id = Date.now() + '_' + Math.random().toString(36).substr(2, 6);
            sharedTGTs.push(tgt);
            broadcastAll({ type: 'tgtSync', targets: sharedTGTs });
            return;
        }
        if (msg.type === 'tgtDelete') {
            sharedTGTs = sharedTGTs.filter(t => t._id !== msg.id);
            broadcastAll({ type: 'tgtSync', targets: sharedTGTs });
            return;
        }
        
        // ---- V15: PCDB (rapports reconnaissance) ----
        if (msg.type === 'pcdbAdd') {
            const r = msg.report;
            if (!r || typeof r.lat !== 'number' || typeof r.lon !== 'number' || !r.text) return;
            // Replace any pre-existing entry with the same id (idempotent — useful on reconnect)
            sharedPCDB = sharedPCDB.filter(x => x.id !== r.id);
            sharedPCDB.push({
                id: r.id,
                lat: r.lat, lon: r.lon,
                text: String(r.text).substring(0, 4000), // safety cap
                author: (r.author || client.name || '?').substring(0, 30),
                timestamp: r.timestamp || Date.now()
            });
            broadcastAll({ type: 'pcdbSync', reports: sharedPCDB });
            return;
        }
        if (msg.type === 'pcdbEdit') {
            const id = msg.id, text = msg.text;
            if (!id || typeof text !== 'string') return;
            const r = sharedPCDB.find(x => x.id === id);
            if (!r) return;
            r.text = text.substring(0, 4000);
            r.editedAt = Date.now();
            r.editedBy = client.name || '?';
            broadcastAll({ type: 'pcdbSync', reports: sharedPCDB });
            return;
        }
        if (msg.type === 'pcdbDelete') {
            if (!msg.id) return;
            sharedPCDB = sharedPCDB.filter(x => x.id !== msg.id);
            broadcastAll({ type: 'pcdbSync', reports: sharedPCDB });
            return;
        }

        // ---- V18: SHARED MAPS POOL ----
        // Workflow: client uploads in chunks (mapUploadStart → mapUploadChunk×N → mapUploadEnd),
        // server stores in memory and broadcasts new metadata to all clients.
        // Other clients can download via mapDownloadRequest → server sends chunks.
        if (msg.type === 'mapUploadStart') {
            const m = msg.meta;
            if (!m || typeof m.id !== 'string' || !m.name || !m.dcsMap) return;
            if (typeof m.sizeBytes !== 'number' || m.sizeBytes <= 0 || m.sizeBytes > 50 * 1024 * 1024) {
                ws.send(JSON.stringify({ type: 'mapUploadResult', id: m.id, ok: false, error: 'Taille invalide (max 50 Mo)' }));
                return;
            }
            const mime = (m.mime || 'image/png').toLowerCase();
            if (!/^image\/(png|jpe?g|webp)$/.test(mime)) {
                ws.send(JSON.stringify({ type: 'mapUploadResult', id: m.id, ok: false, error: 'Format non supporté' }));
                return;
            }
            let up = uploadsInProgress.get(ws);
            if (!up) { up = {}; uploadsInProgress.set(ws, up); }
            up[m.id] = {
                meta: m,
                mime: mime,
                expectedChunks: msg.totalChunks || 0,
                receivedChunks: 0,
                buffers: []
            };
            console.log('  [MAPS] Upload start from ' + (client.name || '?') + ' : ' + m.name + ' (' + Math.round(m.sizeBytes/1024) + ' Ko, ' + msg.totalChunks + ' chunks)');
            return;
        }
        if (msg.type === 'mapUploadChunk') {
            const up = uploadsInProgress.get(ws);
            if (!up || !up[msg.id]) return;
            const slot = up[msg.id];
            try {
                const buf = Buffer.from(msg.data, 'base64');
                slot.buffers[msg.index] = buf;
                slot.receivedChunks++;
            } catch (e) { /* ignore */ }
            return;
        }
        if (msg.type === 'mapUploadEnd') {
            const up = uploadsInProgress.get(ws);
            if (!up || !up[msg.id]) return;
            const slot = up[msg.id];
            // Reassemble
            let full;
            try { full = Buffer.concat(slot.buffers.filter(Boolean)); }
            catch (e) {
                ws.send(JSON.stringify({ type: 'mapUploadResult', id: msg.id, ok: false, error: 'Reconstruction échouée' }));
                delete up[msg.id]; return;
            }
            if (full.length !== slot.meta.sizeBytes) {
                ws.send(JSON.stringify({ type: 'mapUploadResult', id: msg.id, ok: false, error: 'Taille reçue invalide' }));
                delete up[msg.id]; return;
            }
            // Validate magic bytes (basic check)
            const isPNG = full[0] === 0x89 && full[1] === 0x50 && full[2] === 0x4E && full[3] === 0x47;
            const isJPG = full[0] === 0xFF && full[1] === 0xD8 && full[2] === 0xFF;
            const isWebP = full[0] === 0x52 && full[1] === 0x49 && full[2] === 0x46 && full[3] === 0x46;
            if (!isPNG && !isJPG && !isWebP) {
                ws.send(JSON.stringify({ type: 'mapUploadResult', id: msg.id, ok: false, error: 'Données image invalides' }));
                delete up[msg.id]; return;
            }
            // Store
            const id = slot.meta.id;
            const meta = {
                id: id,
                name: String(slot.meta.name).substring(0, 200),
                dcsMap: String(slot.meta.dcsMap).substring(0, 60),
                cornerCoord: String(slot.meta.cornerCoord || '').substring(0, 80),
                widthKm: Number(slot.meta.widthKm) || 0,
                heightKm: Number(slot.meta.heightKm) || 0,
                imgWidth: Number(slot.meta.imgWidth) || 0,
                imgHeight: Number(slot.meta.imgHeight) || 0,
                author: (client.name || '?').substring(0, 30),
                timestamp: Date.now(),
                sizeBytes: full.length,
                mime: slot.mime,
                thumbDataURL: slot.meta.thumbDataURL || null
            };
            // Replace any previous map with the same id
            sharedMapsMeta = sharedMapsMeta.filter(x => x.id !== id);
            sharedMapsMeta.push(meta);
            sharedMapsData[id] = full;
            delete up[msg.id];
            console.log('  [MAPS] Upload OK : ' + meta.name + ' (' + Math.round(meta.sizeBytes/1024) + ' Ko) — total shared : ' + sharedMapsMeta.length);
            // Tell uploader
            ws.send(JSON.stringify({ type: 'mapUploadResult', id: id, ok: true }));
            // Broadcast new list to all
            broadcastAll({ type: 'serverMapsList', maps: sharedMapsMeta });
            return;
        }
        if (msg.type === 'mapDelete') {
            // A client can delete a map they uploaded (by id)
            const id = msg.id;
            if (!id) return;
            const m = sharedMapsMeta.find(x => x.id === id);
            if (!m) return;
            // Only the original author can delete
            if (m.author !== (client.name || '?')) {
                ws.send(JSON.stringify({ type: 'mapDeleteResult', id: id, ok: false, error: 'Seul l\'auteur peut supprimer cette carte' }));
                return;
            }
            sharedMapsMeta = sharedMapsMeta.filter(x => x.id !== id);
            delete sharedMapsData[id];
            ws.send(JSON.stringify({ type: 'mapDeleteResult', id: id, ok: true }));
            broadcastAll({ type: 'serverMapsList', maps: sharedMapsMeta });
            console.log('  [MAPS] Deleted : ' + id);
            return;
        }
        if (msg.type === 'mapDownloadRequest') {
            const id = msg.id;
            if (!id) return;
            const meta = sharedMapsMeta.find(x => x.id === id);
            const data = sharedMapsData[id];
            if (!meta || !data) {
                ws.send(JSON.stringify({ type: 'mapDownloadError', id: id, error: 'Carte introuvable' }));
                return;
            }
            // Send in chunks of 64 KB
            const CHUNK = 64 * 1024;
            const total = Math.ceil(data.length / CHUNK);
            ws.send(JSON.stringify({ type: 'mapDownloadStart', id: id, meta: meta, totalChunks: total }));
            for (let i = 0; i < total; i++) {
                const start = i * CHUNK;
                const end = Math.min(start + CHUNK, data.length);
                const slice = data.slice(start, end);
                ws.send(JSON.stringify({
                    type: 'mapDownloadChunk',
                    id: id,
                    index: i,
                    data: slice.toString('base64')
                }));
            }
            ws.send(JSON.stringify({ type: 'mapDownloadEnd', id: id }));
            console.log('  [MAPS] Downloaded ' + meta.name + ' to ' + (client.name || '?'));
            return;
        }
        
        // ---- MARQUEURS ENI/AMI ----
        if (msg.type === 'markerAdd') {
            const marker = msg.marker;
            if (!marker) return;
            marker._author = client.name;
            marker._coalition = client.coalition;
            marker._id = Date.now() + '_' + Math.random().toString(36).substr(2, 6);
            sharedMarkers.push(marker);
            broadcastExcept(ws, { type: 'markerAdd', marker: marker });
            return;
        }
        if (msg.type === 'markerDelete') {
            sharedMarkers = sharedMarkers.filter(m => m._id !== msg.id);
            broadcastAll({ type: 'markerSync', markers: sharedMarkers });
            return;
        }
        if (msg.type === 'markerClear') {
            if (msg.all) sharedMarkers = [];
            else sharedMarkers = sharedMarkers.filter(m => m._author !== client.name);
            broadcastAll({ type: 'markerSync', markers: sharedMarkers });
            return;
        }
        
        // ---- PLANS ----
        if (msg.type === 'planShare') {
            const plan = {
                name: (msg.name || 'Plan').substring(0, 30),
                waypoints: msg.waypoints || [],
                _author: client.name,
                _coalition: client.coalition,
                _id: Date.now() + '_' + Math.random().toString(36).substr(2, 6)
            };
            sharedPlans = sharedPlans.filter(p => !(p._author === client.name && p.name === plan.name));
            sharedPlans.push(plan);
            broadcastAll({ type: 'planSync', plans: sharedPlans });
            return;
        }
        if (msg.type === 'planDelete') {
            sharedPlans = sharedPlans.filter(p => p._id !== msg.id);
            broadcastAll({ type: 'planSync', plans: sharedPlans });
            return;
        }
        if (msg.type === 'planDeleteByName') {
            sharedPlans = sharedPlans.filter(p => !(p._author === client.name && p.name === msg.name));
            broadcastAll({ type: 'planSync', plans: sharedPlans });
            return;
        }
        
        // ---- ORDRES UNITÉS ----
        if (msg.type === 'unitOrder') {
            const wps = msg.waypoints || [];
            console.log('  [ORDER] ' + client.name + ': ' + msg.unitName + ' route ' + wps.length + ' WPs');
            try {
                const orderPath = path.join(dcsBasePath, 'Logs', 'sit_unit_order.json');
                // JSONL: append one JSON line per order
                const orderLine = JSON.stringify({
                    unitName: msg.unitName,
                    order: msg.order || 'route',
                    waypoints: wps,
                    speed: msg.speed || 30,
                    formation: msg.formation || 'off_road',
                    roe: msg.roe || 'free',
                    author: client.name
                });
                let existing = '';
                try { if (fs.existsSync(orderPath)) existing = fs.readFileSync(orderPath, 'utf8'); } catch(e2){}
                fs.writeFileSync(orderPath, existing + (existing ? '\n' : '') + orderLine, 'utf8');
            } catch (e) {
                console.log('  [ORDER] ERREUR: ' + e.message);
            }
            // V8: broadcast to all clients so everyone sees the AI route assigned by anyone.
            try {
                broadcastAll({
                    type: 'unitOrderShared',
                    unitName: msg.unitName,
                    order: msg.order || 'route',
                    waypoints: wps,
                    author: client.name,
                    timestamp: Date.now()
                });
            } catch(e2) {}
            return;
        }
        if (msg.type === 'unitSettings') {
            console.log('  [SETTINGS] ' + client.name + ': ' + msg.unitName);
            try {
                const settingsPath = path.join(dcsBasePath, 'Logs', 'sit_unit_settings.json');
                const settingsLine = JSON.stringify({
                    unitName: msg.unitName,
                    speed: msg.speed || 30,
                    formation: msg.formation || 'off_road',
                    roe: msg.roe || 'free',
                    author: client.name
                });
                let existing = '';
                try { if (fs.existsSync(settingsPath)) existing = fs.readFileSync(settingsPath, 'utf8'); } catch(e2){}
                fs.writeFileSync(settingsPath, existing + (existing ? '\n' : '') + settingsLine, 'utf8');
            } catch (e) {
                console.log('  [SETTINGS] ERREUR: ' + e.message);
            }
            return;
        }
        
        // ---- MAP CALIBRATE: client informs us of the PNG map corner/dimensions ----
        // Written to a file that the hook can read to compute exact SIT coords of map corners.
        // Stored globally so we can serve it to new clients too.
        if (msg.type === 'mapCalibrate') {
            try {
                const calPath = path.join(dcsBasePath, 'Logs', 'sit_map_calibrate.json');
                fs.writeFileSync(calPath, JSON.stringify({
                    lat: msg.lat || 0,
                    lon: msg.lon || 0,
                    widthKm: msg.widthKm || 10,
                    heightKm: msg.heightKm || 10,
                    author: client.name,
                    timestamp: Date.now()
                }), 'utf8');
                console.log('  [MAP] Calibration from ' + client.name + ': lat=' + msg.lat + ' lon=' + msg.lon + ' ' + msg.widthKm + 'x' + msg.heightKm + 'km');
            } catch (e) {
                console.log('  [MAP] Erreur écriture calibrate: ' + e.message);
            }
            return;
        }
        
        // ---- DCS screen msg (sent via outTextForCoalition by hook) ----
        if (msg.type === 'msg') {
            console.log('  [DCSMSG] ' + client.name + ' -> ' + (msg.coalition || 'all') + ': ' + (msg.text || '').substring(0, 80));
            try {
                const msgPath = path.join(dcsBasePath, 'Logs', 'sit_multi_msg.json');
                const line = JSON.stringify({
                    coalition: msg.coalition || 'all',
                    author: client.name,
                    text: (msg.text || '').substring(0, 500),
                    duration: msg.duration || 60,
                    timestamp: Date.now()
                }) + '\n';
                fs.appendFileSync(msgPath, line, 'utf8');
            } catch (e) {
                console.log('  [DCSMSG] ERREUR: ' + e.message);
            }
            return;
        }
        
        // ---- MSG ----
        if (msg.type === 'chatMsg') {
            const chatMsg = {
                type: 'chatMsg',
                author: client.name,
                coalition: msg.coalition || client.coalition,
                text: (msg.text || '').substring(0, 200),
                timestamp: Date.now()
            };
            broadcastAll(chatMsg);
            console.log('  [MSG] ' + client.name + ' -> ' + chatMsg.coalition + ': ' + chatMsg.text);
            try {
                const msgPath = path.join(dcsBasePath, 'Logs', 'sit_multi_msg.json');
                const line = JSON.stringify({
                    coalition: chatMsg.coalition,
                    author: client.name,
                    text: chatMsg.text,
                    duration: msg.duration || 60,
                    timestamp: Date.now()
                }) + '\n';
                fs.appendFileSync(msgPath, line, 'utf8');
            } catch (e) {}
            return;
        }
        
        // ---- REFALT (demande d'élévation terrain) ----
        if (msg.type === 'refalt') {
            console.log('  [REFALT] ' + client.name + ': lat=' + msg.lat + ' lon=' + msg.lon + ' refLat=' + msg.refLat + ' refLon=' + msg.refLon);
            // Cancel any pending clear-timer for the previous requester
            if (refaltRequester && refaltRequester._clearTimer) {
                try { clearTimeout(refaltRequester._clearTimer); } catch(e2) {}
                refaltRequester._clearTimer = null;
            }
            refaltRequester = ws; // Track who asked
            try {
                const refaltPath = path.join(dcsBasePath, 'Logs', 'sit_refalt_request.json');
                const req = {
                    lat: msg.lat, lon: msg.lon,
                    refLat: msg.refLat, refLon: msg.refLon,
                    timestamp: Date.now()
                };
                if (msg.mapLat !== undefined) {
                    req.mapLat = msg.mapLat;
                    req.mapLon = msg.mapLon;
                    req.mapWKm = msg.mapWKm;
                    req.mapHKm = msg.mapHKm;
                }
                fs.writeFileSync(refaltPath, JSON.stringify(req), 'utf8');
            } catch (e) {
                console.log('  [REFALT] ERREUR: ' + e.message);
            }
            return;
        }
        
        // ---- SMOKE (fumigènes) ----
        if (msg.type === 'smoke') {
            const colorNames = {0:'green',1:'red',2:'white',3:'orange',4:'blue'};
            console.log('  [SMOKE] ' + client.name + ': ' + (colorNames[msg.color] || '?') + ' at ' + msg.lat + ',' + msg.lon);
            try {
                const smokePath = path.join(dcsBasePath, 'Logs', 'sit_smoke.json');
                // Lire les fumigènes en attente (file d'attente)
                let pending = [];
                try {
                    if (fs.existsSync(smokePath)) {
                        pending = JSON.parse(fs.readFileSync(smokePath, 'utf8'));
                        if (!Array.isArray(pending)) pending = [];
                    }
                } catch (e2) { pending = []; }
                pending.push({
                    lat: msg.lat,
                    lon: msg.lon,
                    color: msg.color || 0,
                    author: client.name,
                    timestamp: Date.now()
                });
                fs.writeFileSync(smokePath, JSON.stringify(pending), 'utf8');
            } catch (e) {
                console.log('  [SMOKE] ERREUR: ' + e.message);
            }
            return;
        }
        
        // ---- JFO (Joint Fires Observer) ----
        if (msg.type === 'jfo') {
            console.log('  [JFO] ' + client.name + ': group=' + msg.group + ' weapon=' + msg.weapon + ' shots=' + msg.shots + ' at ' + msg.lat + ',' + msg.lon);
            try {
                const jfoPath = path.join(dcsBasePath, 'Logs', 'sit_jfo_request.json');
                fs.writeFileSync(jfoPath, JSON.stringify({
                    group: msg.group,
                    lat: msg.lat,
                    lon: msg.lon,
                    weapon: msg.weapon || 'auto',
                    shots: msg.shots || 6,
                    radius: msg.radius || 0,
                    author: client.name,
                    timestamp: Date.now()
                }), 'utf8');
            } catch (e) {
                console.log('  [JFO] ERREUR: ' + e.message);
            }
            // V8: broadcast strike info to all clients so everyone sees the firing line + target.
            // Duration = setup (30s) + shots*8s (rough fire rate). Clients use this to expire the visualization.
            try {
                const shots = msg.shots || 6;
                const durationMs = (30 + shots * 8) * 1000;
                broadcastAll({
                    type: 'jfoStrikeShared',
                    group: msg.group,
                    lat: msg.lat,
                    lon: msg.lon,
                    weapon: msg.weapon || 'auto',
                    shots: shots,
                    radius: msg.radius || 0,
                    author: client.name,
                    timestamp: Date.now(),
                    durationMs: durationMs
                });
            } catch(e2) {}
            return;
        }
        
        // ---- V12: PING (rapid ping broadcast to all clients) ----
        if (msg.type === 'pingShared') {
            try {
                broadcastAll({
                    type: 'pingShared',
                    lat: msg.lat,
                    lon: msg.lon,
                    pingType: msg.pingType || 'visual',
                    author: client.name,
                    timestamp: msg.timestamp || Date.now()
                });
            } catch (e) {}
            return;
        }
        
        // ---- SPAWN 105 (XL package) ----
        if (msg.type === 'spawn105') {
            console.log('  [SPAWN105] ' + client.name + ': at ' + msg.lat + ',' + msg.lon);
            try {
                const spawn105Path = path.join(dcsBasePath, 'Logs', 'sit_spawn105.json');
                const orderLine = JSON.stringify({
                    lat: msg.lat,
                    lon: msg.lon,
                    coalition: msg.coalition || 2,
                    author: client.name,
                    timestamp: Date.now()
                }) + '\n';
                fs.appendFileSync(spawn105Path, orderLine, 'utf8');
            } catch (e) {
                console.log('  [SPAWN105] ERREUR: ' + e.message);
            }
            return;
        }
        
        // ---- SPAWN CSAR (MERCURE + CHROME only) ----
        if (msg.type === 'spawnCSAR') {
            console.log('  [SPAWNCSAR] ' + client.name + ': at ' + msg.lat + ',' + msg.lon);
            try {
                const csarPath = path.join(dcsBasePath, 'Logs', 'sit_spawn_csar.json');
                const orderLine = JSON.stringify({
                    lat: msg.lat,
                    lon: msg.lon,
                    coalition: msg.coalition || 2,
                    author: client.name,
                    timestamp: Date.now()
                }) + '\n';
                fs.appendFileSync(csarPath, orderLine, 'utf8');
            } catch (e) {
                console.log('  [SPAWNCSAR] ERREUR: ' + e.message);
            }
            return;
        }
        
        // ---- RAVITO 120 (Cubi + Pamela vers joueur) ----
        if (msg.type === 'ravito120') {
            console.log('  [RAVITO] ' + client.name + ': player=' + (msg.playerName || client.name));
            try {
                const ravitoPath = path.join(dcsBasePath, 'Logs', 'sit_ravito_order.json');
                const orderLine = JSON.stringify({
                    playerName: msg.playerName || client.name,
                    author: client.name,
                    timestamp: Date.now()
                }) + '\n';
                fs.appendFileSync(ravitoPath, orderLine, 'utf8');
            } catch (e) {
                console.log('  [RAVITO] ERREUR: ' + e.message);
            }
            return;
        }
        if (msg.type === 'ravito120Cancel') {
            console.log('  [RAVITO] ' + client.name + ': CANCEL for ' + (msg.playerName || client.name));
            try {
                const ravitoPath = path.join(dcsBasePath, 'Logs', 'sit_ravito_order.json');
                const orderLine = JSON.stringify({
                    action: 'cancel',
                    playerName: msg.playerName || client.name,
                    author: client.name,
                    timestamp: Date.now()
                }) + '\n';
                fs.appendFileSync(ravitoPath, orderLine, 'utf8');
            } catch (e) {
                console.log('  [RAVITO] ERREUR: ' + e.message);
            }
            return;
        }
        
        // ---- EVASAN / CSAR ----
        if (msg.type === 'evasanOrder') {
            console.log('  [EVASAN] ' + client.name + ': action=' + msg.action + ' player=' + msg.playerName + ' at ' + msg.lat + ',' + msg.lon);
            try {
                const evasanOrderPath = path.join(dcsBasePath, 'Logs', 'sit_evasan_order.json');
                // Append as JSONL (one order per line)
                const orderLine = JSON.stringify({
                    action: msg.action,
                    lat: msg.lat,
                    lon: msg.lon,
                    playerName: msg.playerName,
                    onRoad: !!msg.onRoad,
                    coalition: msg.coalition || 2,
                    eventType: msg.eventType || 'crash',
                    author: client.name,
                    timestamp: Date.now()
                }) + '\n';
                fs.appendFileSync(evasanOrderPath, orderLine, 'utf8');
                // Broadcast order to other clients for sync
                broadcastAll({ type: 'evasanOrder', ...msg, author: client.name });
            } catch (e) {
                console.log('  [EVASAN] ERREUR: ' + e.message);
            }
            return;
        }
    });
    
    ws.on('close', () => {
        const client = clients.get(ws);
        if (client && client.authenticated) {
            console.log('  [-] ' + client.name + ' déconnecté');
            sharedDrones = sharedDrones.filter(d => d.owner !== client.name);
            broadcastAll({ type: 'droneSync', drones: sharedDrones });
        }
        clients.delete(ws);
        broadcastClientList();
    });
    
    ws.on('error', () => {
        const client = clients.get(ws);
        if (client && client.authenticated) {
            sharedDrones = sharedDrones.filter(d => d.owner !== client.name);
            broadcastAll({ type: 'droneSync', drones: sharedDrones });
        }
        clients.delete(ws);
    });
});

// ============================================================================
// BROADCAST
// ============================================================================
function broadcastAll(msg) {
    const json = JSON.stringify(msg);
    const isHeavy = msg.type === 'worldstate'; // Large, frequent payload
    wss.clients.forEach(c => {
        if (c.readyState !== WebSocket.OPEN) return;
        const cl = clients.get(c);
        if (!cl || !cl.authenticated) return;
        // Back-pressure: if client can't keep up, skip heavy messages rather than queueing them
        if (isHeavy && c.bufferedAmount > 128000) {
            return;
        }
        try { c.send(json); } catch (e) {}
    });
}

// V7: Per-client worldstate diff. Cache each client's last-sent snapshot; send only changed/removed units.
// Signature = position/heading/life/speed encoded as a short string; compare cheap.
// Full resync every 30 cycles (~60s) or on client reconnect.
const FULL_RESYNC_EVERY = 30;
function unitSig(u) {
    // Coarse signature: position rounded to 5m, heading to 2°, life to 5%.
    // Only fields that realistically change in normal play contribute to the signature.
    const lat = Math.round(u.lat * 20000) / 20000; // 5m lat precision
    const lon = Math.round(u.lon * 20000) / 20000;
    const hdg = Math.round((u.hdg || 0) / 2) * 2;
    const life = Math.round((u.life || 0) / 5) * 5;
    const spd = Math.round(u.spd || 0);
    return lat + ',' + lon + ',' + hdg + ',' + life + ',' + spd;
}

function broadcastWorldstateDelta(units) {
    // Build name->unit map once
    const currentByName = new Map();
    for (const u of units) {
        if (u.n) currentByName.set(u.n, u);
    }
    
    wss.clients.forEach(c => {
        if (c.readyState !== WebSocket.OPEN) return;
        const cl = clients.get(c);
        if (!cl || !cl.authenticated) return;
        // Back-pressure: skip this update for slow clients
        if (c.bufferedAmount > 128000) return;
        
        // Init client cache on first broadcast
        if (!cl.wsCache) { cl.wsCache = new Map(); cl.wsCycles = 0; }
        cl.wsCycles++;
        
        // Full resync periodically or if cache is empty
        const fullResync = cl.wsCycles === 1 || (cl.wsCycles % FULL_RESYNC_EVERY) === 0;
        
        if (fullResync) {
            // Send full worldstate, refresh cache
            cl.wsCache.clear();
            for (const [name, u] of currentByName) {
                cl.wsCache.set(name, unitSig(u));
            }
            try { c.send(JSON.stringify({ type: 'worldstate', units: units })); } catch (e) {}
            return;
        }
        
        // Compute delta
        const changed = [];
        const removed = [];
        for (const [name, u] of currentByName) {
            const sig = unitSig(u);
            const prevSig = cl.wsCache.get(name);
            if (prevSig !== sig) {
                changed.push(u);
                cl.wsCache.set(name, sig);
            }
        }
        // Detect removed
        for (const name of cl.wsCache.keys()) {
            if (!currentByName.has(name)) {
                removed.push(name);
                cl.wsCache.delete(name);
            }
        }
        
        // Skip broadcast if nothing changed (big optimization)
        if (changed.length === 0 && removed.length === 0) return;
        
        try {
            c.send(JSON.stringify({ type: 'worldstateDelta', changed: changed, removed: removed }));
        } catch (e) {}
    });
}

function broadcastExcept(except, msg) {
    const json = JSON.stringify(msg);
    wss.clients.forEach(c => {
        if (c !== except && c.readyState === WebSocket.OPEN) {
            const cl = clients.get(c);
            if (cl && cl.authenticated) c.send(json);
        }
    });
}

function broadcastToRole(role, msg) {
    const json = JSON.stringify(msg);
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
            const cl = clients.get(c);
            if (cl && cl.authenticated && cl.role === role) c.send(json);
        }
    });
}

function broadcastClientList() {
    const list = [];
    clients.forEach((cl) => {
        if (cl.authenticated) {
            list.push({ name: cl.name, vehicle: cl.vehicle, coalition: cl.coalition, role: cl.role });
        }
    });
    broadcastAll({ type: 'clientList', clients: list });
    console.log('  [INFO] ' + list.length + ' client(s) connecté(s)');
    // When running as a child of the Electron app, emit a structured snapshot on stdout
    // so the parent (server-host.js) can forward it to the Server window via IPC.
    // The line starts with a unique prefix so the parser can distinguish it from logs.
    if (process.env.MCLSIT_SERVER === '1') {
        try {
            process.stdout.write('@@MCLSIT_SNAPSHOT@@' + JSON.stringify({
                clients: list,
                count: list.length,
                port: PORT
            }) + '\n');
        } catch (e) {}
    }
}

// ============================================================================
// UDP : Reception worldstate + players depuis SIT_WorldHook.lua
// ============================================================================
const udpHook = dgram.createSocket('udp4');
const pendingFragments = {};
let udpWorldActive = false;
let udpPlayersActive = false;
let lastUdpWorldTs = 0;
let lastUdpPlayersTs = 0;

// Detect UDP stream loss (e.g., DCS mission change): if no packet for >10s, re-enable file fallback
setInterval(() => {
    const now = Date.now();
    if (udpWorldActive && now - lastUdpWorldTs > 10000) {
        udpWorldActive = false;
        console.log('  [!] UDP worldstate silent >10s - file fallback re-enabled');
    }
    if (udpPlayersActive && now - lastUdpPlayersTs > 10000) {
        udpPlayersActive = false;
        console.log('  [!] UDP players silent >10s - file fallback re-enabled');
    }
}, 2000);

function processHookMessage(content) {
    const pipeIdx = content.indexOf('|');
    if (pipeIdx < 0) return;
    const prefix = content.substring(0, pipeIdx);
    const data = content.substring(pipeIdx + 1);
    
    if (prefix === 'W') {
        try {
            const units = JSON.parse(data);
            lastWorldstate = units;
            udpWorldActive = true;
            lastUdpWorldTs = Date.now();
            broadcastWorldstateDelta(units);
        } catch (e) {
            console.log('  [!] W parse error: ' + e.message + ' (data length: ' + data.length + ')');
        }
    } else if (prefix === 'E') {
        // Elevation data: forward only to the client who requested it.
        // V8: the hook sends two payloads (fine 50x50km then coarse 200x200km).
        // Keep refaltRequester until a 10s window expires so both reach the client.
        try {
            console.log('  [REFALT] Elevation data received: ' + data.length + ' bytes');
            if (refaltRequester && refaltRequester.readyState === WebSocket.OPEN) {
                refaltRequester.send(JSON.stringify({ type: 'elevation', raw: data }));
                // schedule clear after a delay so the second (coarse) payload still finds the requester
                if (!refaltRequester._clearTimer) {
                    refaltRequester._clearTimer = setTimeout(() => {
                        if (refaltRequester) {
                            refaltRequester._clearTimer = null;
                            refaltRequester = null;
                        }
                    }, 10000);
                }
            }
        } catch (e) {}
    } else if (prefix === 'C') {
        // Calibration data: forward to all clients
        try {
            console.log('  [CALIB] ' + data);
            broadcastAll({ type: 'calibration', raw: data });
        } catch (e) {}
    } else if (prefix === 'P') {
        try {
            const playersData = JSON.parse(data);
            udpPlayersActive = true;
            lastUdpPlayersTs = Date.now();
            wss.clients.forEach(c => {
                if (c.readyState !== WebSocket.OPEN) return;
                const cl = clients.get(c);
                if (!cl || !cl.authenticated) return;
                const pData = playersData[cl.name];
                if (pData) {
                    const msg = { type: 'dcsData' };
                    if (pData.ammo) msg.ammo = pData.ammo;
                    if (pData.life !== undefined && pData.life >= 0) msg.lifePct = parseInt(pData.life);
                    c.send(JSON.stringify(msg));
                }
            });
        } catch (e) {}
    } else if (prefix === 'O') {
        // V8: per-player own-vehicle telemetry. Routed to matching authenticated client by name.
        try {
            const entries = JSON.parse(data);
            if (!Array.isArray(entries)) return;
            for (const entry of entries) {
                if (!entry || !entry.pn) continue;
                wss.clients.forEach(c => {
                    if (c.readyState !== WebSocket.OPEN) return;
                    const cl = clients.get(c);
                    if (!cl || !cl.authenticated) return;
                    if (cl.name === entry.pn) {
                        try {
                            c.send(JSON.stringify(Object.assign({ type: 'ownVehicle' }, entry)));
                        } catch (e) {}
                    }
                });
            }
        } catch (e) {
            console.log('  [!] O parse error: ' + e.message);
        }
    } else if (prefix === 'M') {
        // V10: mission lifecycle events from the hook (e.g. mission reset)
        try {
            const ev = JSON.parse(data);
            console.log('  [MISSION] event=' + ev.event);
            if (ev.event === 'missionReset') {
                // Wipe server-side per-mission state so stale data doesn't leak across missions
                lastWorldstate = null;
                udpWorldActive = false;
                // Reset per-client worldstate diff caches: forces a full resync on the next worldstate
                wss.clients.forEach(c => {
                    const cl = clients.get(c);
                    if (cl) {
                        if (cl.wsCache) cl.wsCache.clear();
                        cl.wsCycles = 0;
                    }
                });
                // Broadcast to all clients so they wipe their own caches and re-prompt for REFALT
                broadcastAll({ type: 'missionReset', timestamp: ev.timestamp || Date.now() });
                console.log('  [MISSION] missionReset broadcast to ' + wss.clients.size + ' client(s)');
            }
        } catch (e) {
            console.log('  [!] M parse error: ' + e.message);
        }
    }
}

udpHook.on('message', (msg) => {
    try {
        const raw = msg.toString('utf8');
        const prefix = raw.charAt(0) === 'S' ? raw.charAt(1) : (raw.charAt(0) === 'F' ? 'F:' + raw.substring(2, raw.indexOf('|', 2)) : '?');
        if (prefix !== 'W' && prefix !== 'F:W' && prefix !== 'P' && prefix !== 'F:P' && prefix !== 'O' && prefix !== 'F:O' && prefix !== 'M' && prefix !== 'F:M') {
            console.log('  [UDP] received: ' + prefix + ' (' + raw.length + ' bytes)');
        }
        if (raw.charAt(0) === 'S') {
            processHookMessage(raw.substring(1));
        } else if (raw.charAt(0) === 'F') {
            const p1 = raw.indexOf('|', 2);
            const p2 = raw.indexOf('|', p1 + 1);
            const p3 = raw.indexOf('|', p2 + 1);
            const p4 = raw.indexOf('|', p3 + 1);
            const prefix = raw.substring(2, p1);
            const msgId = raw.substring(p1 + 1, p2);
            const partNum = parseInt(raw.substring(p2 + 1, p3));
            const totalParts = parseInt(raw.substring(p3 + 1, p4));
            const data = raw.substring(p4 + 1);
            const fragKey = prefix + '_' + msgId;
            if (!pendingFragments[fragKey]) {
                pendingFragments[fragKey] = { parts: {}, total: totalParts, received: 0, time: Date.now(), prefix: prefix };
            }
            const frag = pendingFragments[fragKey];
            if (!frag.parts[partNum]) { frag.parts[partNum] = data; frag.received++; }
            if (frag.received === frag.total) {
                let full = '';
                for (let i = 1; i <= frag.total; i++) full += frag.parts[i] || '';
                delete pendingFragments[fragKey];
                processHookMessage(frag.prefix + '|' + full);
            }
        }
    } catch (e) {}
});

setInterval(() => {
    const now = Date.now();
    for (const id in pendingFragments) {
        if (now - pendingFragments[id].time > 5000) delete pendingFragments[id];
    }
}, 5000);

udpHook.on('error', (err) => { console.log('  [!] UDP hook error: ' + err.message); });
udpHook.bind(UDP_HOOK_PORT, '0.0.0.0', () => {
    console.log('  [OK] UDP hook port ' + UDP_HOOK_PORT);
    try {
        // Raise UDP receive buffer to avoid packet loss when hook sends fragmented worldstate
        udpHook.setRecvBufferSize(4 * 1024 * 1024); // 4 MB
    } catch (e) { console.log('  [!] setRecvBufferSize failed: ' + e.message); }
});

// ============================================================================
// FALLBACK FICHIER : si pas de donnees UDP
// ============================================================================
setInterval(() => {
    if (udpWorldActive) return;
    try {
        const worldPath = path.join(dcsBasePath, 'Logs', 'sit_worldstate.json');
        if (!fs.existsSync(worldPath)) return;
        const stat = fs.statSync(worldPath);
        if (Date.now() - stat.mtimeMs > 10000) return;
        const raw = fs.readFileSync(worldPath, 'utf8');
        const units = JSON.parse(raw);
        lastWorldstate = units;
        broadcastAll({ type: 'worldstate', units: units });
    } catch (e) {}
}, 2000);

setInterval(() => {
    if (udpPlayersActive) return;
    try {
        const playersPath = path.join(dcsBasePath, 'Logs', 'sit_players.json');
        if (!fs.existsSync(playersPath)) return;
        const stat = fs.statSync(playersPath);
        if (Date.now() - stat.mtimeMs > 10000) return;
        const raw = fs.readFileSync(playersPath, 'utf8');
        const playersData = JSON.parse(raw);
        wss.clients.forEach(c => {
            if (c.readyState !== WebSocket.OPEN) return;
            const cl = clients.get(c);
            if (!cl || !cl.authenticated) return;
            const pData = playersData[cl.name];
            if (pData) {
                const msg = { type: 'dcsData' };
                if (pData.ammo) msg.ammo = pData.ammo;
                if (pData.life !== undefined && pData.life >= 0) msg.lifePct = parseInt(pData.life);
                c.send(JSON.stringify(msg));
            }
        });
    } catch (e) {}
}, 2000);

// ============================================================================
// NETTOYAGE
// ============================================================================
setInterval(() => {
    const now = Date.now();
    const before = sharedDrones.length;
    // 10s timeout - drones update every 1s, so 10s stale = owner disconnected
    sharedDrones = sharedDrones.filter(d => now - d.timestamp < 10000);
    if (sharedDrones.length !== before) {
        broadcastAll({ type: 'droneSync', drones: sharedDrones });
    }
}, 2000);

// ============================================================================
// RAVITO 120: poll events file written by hook
// ============================================================================
const ravitoEventsPath = path.join(dcsBasePath, 'Logs', 'sit_ravito_events.json');
setInterval(() => {
    try {
        if (!fs.existsSync(ravitoEventsPath)) return;
        const raw = fs.readFileSync(ravitoEventsPath, 'utf8');
        if (!raw || raw.length < 5) return;
        const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
        lines.forEach(line => {
            try {
                const ev = JSON.parse(line);
                console.log('  [RAVITO] result: ' + ev.result + ' player=' + ev.playerName);
                // Forward only to the specific client (by author name)
                wss.clients.forEach(c => {
                    if (c.readyState !== WebSocket.OPEN) return;
                    const cl = clients.get(c);
                    if (!cl || !cl.authenticated) return;
                    if (cl.name === ev.playerName || cl.name === ev.author) {
                        c.send(JSON.stringify({ type: 'ravitoResult', ...ev }));
                    }
                });
            } catch (e) {}
        });
        // Clear file after processing
        try { fs.writeFileSync(ravitoEventsPath, '', 'utf8'); } catch (e) {}
    } catch (e) {}
}, 2000);

// ============================================================================
// MODS STATUS: read from hook-written file, broadcast to new clients
// ============================================================================
let modsStatus = null; // {modpack, kap, dam}
const modsStatusPath = path.join(dcsBasePath, 'Logs', 'sit_mods_status.json');
setInterval(() => {
    try {
        if (!fs.existsSync(modsStatusPath)) return;
        const raw = fs.readFileSync(modsStatusPath, 'utf8');
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const changed = !modsStatus || modsStatus.modpack !== parsed.modpack || modsStatus.kap !== parsed.kap || modsStatus.dam !== parsed.dam;
        modsStatus = parsed;
        if (changed) {
            console.log('  [MODS] status: ' + JSON.stringify(modsStatus));
            broadcastAll({ type: 'modsStatus', mods: modsStatus });
        }
    } catch (e) {}
}, 5000);

// ============================================================================
// EVASAN: poll events file written by hook
// ============================================================================
const evasanEventsPath = path.join(dcsBasePath, 'Logs', 'sit_evasan_events.json');
const evasanProcessedIds = new Set();
setInterval(() => {
    try {
        if (!fs.existsSync(evasanEventsPath)) return;
        const raw = fs.readFileSync(evasanEventsPath, 'utf8');
        if (!raw || raw.length < 5) return;
        // JSONL: one event per line
        const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
        const newEvents = [];
        lines.forEach(line => {
            try {
                const ev = JSON.parse(line);
                // Dedupe: use id or type+playerName as fallback
                const key = ev.id ? ('e' + ev.id) : (ev.type + '_' + (ev.playerName || '') + '_' + (ev.unitName || ''));
                if (evasanProcessedIds.has(key)) return;
                evasanProcessedIds.add(key);
                newEvents.push(ev);
            } catch (e) {}
        });
        // Truncate file if too many processed (keep last 200 processed keys)
        if (evasanProcessedIds.size > 500) {
            const arr = Array.from(evasanProcessedIds);
            evasanProcessedIds.clear();
            arr.slice(-200).forEach(k => evasanProcessedIds.add(k));
        }
        // Broadcast new events
        newEvents.forEach(ev => {
            if (ev.type === 'evasan_result' || ev.type === 'evasan_done' || ev.type === 'evasan_ground_done') {
                console.log('  [EVASAN] result: ' + ev.type + ' ' + (ev.playerName || ''));
                // Keep outer type='evasanResult', move inner type to resultType
                broadcastAll({ type: 'evasanResult', resultType: ev.type, playerName: ev.playerName, action: ev.action, result: ev.result, detail: ev.detail, reason: ev.reason });
            } else {
                // Crash event
                console.log('  [EVASAN] crash: ' + ev.playerName + ' (' + ev.type + ')');
                broadcastAll({ type: 'evasanEvent', event: ev });
            }
        });
        // After processing, clear the file
        if (newEvents.length > 0) {
            try { fs.writeFileSync(evasanEventsPath, '', 'utf8'); } catch (e) {}
        }
    } catch (e) {}
}, 2000);

// Arrêt propre
process.on('SIGINT', () => {
    console.log('\n  Arrêt du serveur SIT V6...');
    wss.close();
    process.exit(0);
});

console.log('  Serveur prêt. En attente sur le port ' + PORT + '...');
console.log('');

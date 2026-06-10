'use strict';

require('dotenv').config();

const http = require('http');
const fs   = require('fs');
const path = require('path');

const STATIC_URL = process.env.STATIC_URL || '';
const { WebSocketServer } = require('ws');

const crypto = require('node:crypto');

const {
    createInitialState, initFormations, FORMATION_HOME, FORMATION_AWAY,
    initToss, chooseTossResult,
    moveSetupPlayer, demoteToReserve, swapReservePlayer, swapSetupPlayers, confirmSetup, validateSetup,
    cancelActivation, endActivation, endTurn,
    moveSolidDefencePlayer, demoteSolidDefencePlayer,
    kickoffQuickSnapMove, fixReferences,
} = require('./public/engine/core.js');
const {
    activateMover, movePlayer, resolveDivingTackle,
    activateBlitz, setBlitzTarget, blitzBlock,
    declareBlock, pickBlockFace, pickPushSquare, resolveFollowUp,
    rerollBlockDice, declareProBlock, proBlockRerollDie,
    resolveFend, resolveStandFirm, resolveStripBall, resolveWrestle, resolveJuggernaut,
    resolveASHit,
    declareFoul, executeFoul, resolveArgueCall,
    declareHandoff, doHandoff,
    declarePass, throwBall, resolvePassReroll, chooseInterceptor,
    declareKick, touchbackGiveBall, secureBall,
    resolveKickScatter, highKickPlace, skipHighKick,
    declarePV, executePV,
    declareStab, executeStab,
    declareTTM, pickTTMMissile, throwTeamMate,
    useTeamReroll, declineTeamReroll,
    resolveBribe,
} = require('./public/engine/actions.js');
const TM = require('./public/engine/teams.js');
const { getGameContext } = require('./public/engine/truth.js');
const { COLS, ROWS, playerAt } = require('./public/engine/helpers.js');

// ── Static file server ───────────────────────────────────────────

const MIME_TYPES = {
    '.html': 'text/html',
    '.js':   'text/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.gif':  'image/gif',
    '.png':  'image/png',
};

const PUB_DIR = path.join(__dirname, 'public');

const httpServer = http.createServer((req, res) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { res.writeHead(400); res.end('Bad request'); return; }

    // Internal server-to-server endpoint (bbauth pre-registers a match here).
    if (req.method === 'POST' && pathname === '/internal/match') {
        return handleInternalMatch(req, res);
    }

    const filePath = pathname === '/' ? '/index.html' : pathname;
    const fullPath = path.resolve(PUB_DIR, '.' + filePath);
    if (!fullPath.startsWith(PUB_DIR + path.sep)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    const ext      = path.extname(fullPath);
    const mimeType = MIME_TYPES[ext] || 'text/plain';

    fs.readFile(fullPath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }

        if ((filePath === '/index.html' || filePath === '/test.html') && STATIC_URL) {
            const injection = [
                `<link rel="stylesheet" href="${STATIC_URL}/style.css">`,
                `  <script>window.STATIC_BASE = ${JSON.stringify(STATIC_URL)};</script>`,
                `  <script src="${STATIC_URL}/banner.js" defer></script>`,
            ].join('\n  ');
            data = Buffer.from(data.toString().replace('<!-- STATIC_INJECT -->', injection));
        }

        res.writeHead(200, { 'Content-Type': mimeType });
        res.end(data);
    });
});

// ── Auth token verification ───────────────────────────────────────
// Verifies a token issued by bbauth and returns its full payload
// ({ userId, username, teamDef }), or null.

function verifyAuthPayload(raw) {
    if (!raw || !process.env.SHARED_SECRET) return null;
    try {
        const [payload, sig] = raw.split('.');
        const expected = crypto.createHmac('sha256', process.env.SHARED_SECRET).update(payload).digest('hex');
        if (sig !== expected) return null;
        const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
        if (data.exp < Math.floor(Date.now() / 1000)) return null;
        return data;
    } catch { return null; }
}

function verifyAuthToken(raw) {
    return verifyAuthPayload(raw)?.teamDef || null;
}

// ── Internal server-to-server channel (bbauth ↔ webbb) ────────────
// Mirrors the play-token handshake in the other direction: bodies are signed
// with the shared secret so neither service trusts an unsigned internal call.

function signBody(rawBody) {
    return crypto.createHmac('sha256', process.env.SHARED_SECRET || '').update(rawBody).digest('hex');
}

function verifyBodySig(rawBody, sig) {
    if (!sig || !process.env.SHARED_SECRET) return false;
    const expected = signBody(rawBody);
    // timingSafeEqual throws on length mismatch — guard it
    return expected.length === sig.length &&
        crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

// ── Default teams ─────────────────────────────────────────────────

function loadTeamDef(filename) {
    const raw = fs.readFileSync(path.join(__dirname, 'public', filename), 'utf8');
    return JSON.parse(raw);
}

const DEFAULT_HOME = loadTeamDef('team-humans.json');
const DEFAULT_AWAY = loadTeamDef('team-orcs.json');

// ── Room manager ──────────────────────────────────────────────────
// Each room is fully isolated: own game state, own sockets.

const rooms = new Map();

// ── Game-state persistence ────────────────────────────────────────
// Rooms live in memory, so a server restart (redeploy or crash) would lose
// every active game and players could not reconnect ("Room not found"). We
// snapshot started games to SQLite on each state change and reload them on
// boot. NOTE: on hosts with an ephemeral filesystem (e.g. Railway without a
// volume) this survives a process crash but not a redeploy — point ROOMS_DB
// at a persistent volume for full durability.

let roomsDb = null;
try {
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = process.env.ROOMS_DB || path.join(__dirname, 'data', 'rooms.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    roomsDb = new DatabaseSync(dbPath);
    roomsDb.exec(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)`);
} catch (e) {
    console.warn('Room persistence disabled:', e.message);
}

const ROOM_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;   // discard snapshots older than 6h on boot
const ROOM_RESTORE_GRACE_MS = 5 * 60 * 1000;       // window for players to reconnect after a restart
const ROOM_REGISTER_TTL_MS  = 5 * 60 * 1000;       // drop a registered room if no game ever starts

function persistRoom(room) {
    // Only snapshot a started game, and never mid-reroll: G.pending (kind
    // 'reroll') holds function closures that don't survive JSON. Skipping it
    // means the saved snapshot is always a clean, resolvable state (the player
    // just re-attempts the interrupted roll after a restart).
    if (!roomsDb || !room.G || room.G.pending?.kind === 'reroll') return;
    try {
        const data = JSON.stringify({
            id: room.id, tokens: room.tokens,
            homeUserId: room.homeUserId, awayUserId: room.awayUserId,
            homeUsername: room.homeUsername, awayUsername: room.awayUsername,
            homeTeamDef: room.homeTeamDef, awayTeamDef: room.awayTeamDef,
            homeTeam: room.homeTeam, awayTeam: room.awayTeam, G: room.G,
            reported: room.reported, log: room.log,
        });
        roomsDb.prepare(`INSERT INTO rooms (id, data, updated) VALUES (?, ?, ?)
                         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated = excluded.updated`)
               .run(room.id, data, Date.now());
    } catch (e) { console.warn(`persistRoom(${room.id}) failed:`, e.message); }
}

function unpersistRoom(id) {
    if (!roomsDb) return;
    try { roomsDb.prepare('DELETE FROM rooms WHERE id = ?').run(id); } catch {}
}

function loadPersistedRooms() {
    if (!roomsDb) return;
    try {
        roomsDb.prepare('DELETE FROM rooms WHERE updated < ?').run(Date.now() - ROOM_SNAPSHOT_TTL_MS);
        const saved = roomsDb.prepare('SELECT data FROM rooms').all();
        for (const row of saved) {
            const s = JSON.parse(row.data);
            fixReferences(s.G);   // re-link player object refs lost in the JSON round-trip
            const room = {
                id: s.id, home: null, away: null, G: s.G, tokens: s.tokens,
                homeUserId: s.homeUserId, awayUserId: s.awayUserId,
                homeUsername: s.homeUsername, awayUsername: s.awayUsername,
                homeTeamDef: s.homeTeamDef, awayTeamDef: s.awayTeamDef,
                homeTeam: s.homeTeam, awayTeam: s.awayTeam,
                lastLogMsg: null, reconnectTimer: null, reported: !!s.reported,
                log: s.log || [],
                // Seed turn tracking from the restored state so the first
                // post-restore broadcast doesn't re-emit a turn-start marker.
                _logPrevActive: s.G?.active ?? null, _logPrevPhase: s.G?.phase ?? null,
            };
            // If nobody reconnects after the restart, the game is abandoned.
            room.reconnectTimer = setTimeout(() => {
                console.log(`Room ${room.id}: no reconnect after restart — destroying`);
                reportResult(room, 'abandoned');
                destroyRoom(room);
            }, ROOM_RESTORE_GRACE_MS);
            rooms.set(s.id, room);
        }
        if (saved.length) console.log(`Restored ${saved.length} active game(s) from disk`);
    } catch (e) { console.warn('loadPersistedRooms failed:', e.message); }
}

function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id;
    do { id = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
    while (rooms.has(id));
    return id;
}

function generateToken() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function _releaseFromRoom(ws) {
    const old = roomOf(ws);
    if (!old) return;
    const side = sideOf(old, ws);
    if (side) old[side] = null;
}

// ── Match registration ────────────────────────────────────────────
// bbauth pre-registers the match (POST /internal/match) before redirecting
// either browser, so the room always exists before either player attaches —
// no create/join race. Each slot's team and userId are fixed here; ATTACH
// later just maps an authenticated userId to its slot.

function registerMatch({ roomId, home, away }) {
    const id = roomId && !rooms.has(roomId) ? roomId : (roomId || generateRoomId());
    const existing = rooms.get(id);
    if (existing) return existing;   // idempotent: a retried registration is a no-op
    const room = {
        id, home: null, away: null, G: null, lastLogMsg: null,
        tokens: { home: null, away: null },
        homeUserId: home.userId, awayUserId: away.userId,
        homeUsername: home.username, awayUsername: away.username,
        homeTeamDef: home.teamDef || null, awayTeamDef: away.teamDef || null,
        reconnectTimer: null, registrationTimer: null, reported: false,
        log: [],   // play-by-play history, so a reconnecting client can rebuild it
    };
    rooms.set(id, room);
    // If neither player ever attaches, don't leak the empty room forever.
    room.registrationTimer = setTimeout(() => {
        if (!room.G) {
            console.log(`Room ${id}: registered but never started — dropping`);
            if (room.home) room.home.send(JSON.stringify({ type: 'ERROR', msg: 'Opponent never joined' }));
            if (room.away) room.away.send(JSON.stringify({ type: 'ERROR', msg: 'Opponent never joined' }));
            destroyRoom(room);
        }
    }, ROOM_REGISTER_TTL_MS);
    console.log(`Room ${id} registered — ${home.username} (home) vs ${away.username} (away)`);
    return room;
}

function handleInternalMatch(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
        if (!verifyBodySig(body, req.headers['x-bb-signature'])) {
            res.writeHead(401); res.end('Bad signature'); return;
        }
        let data;
        try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('Bad JSON'); return; }
        if (!data.roomId || !data.home || !data.away) { res.writeHead(400); res.end('Missing fields'); return; }
        try {
            registerMatch(data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, roomId: data.roomId }));
        } catch (e) {
            console.error('registerMatch failed:', e.message);
            res.writeHead(500); res.end('Registration failed');
        }
    });
}

// A player's browser attaches to its pre-registered slot. The play token
// identifies the userId, which we map to the home/away slot fixed at
// registration. Once both slots are attached, the game starts.
function attachToRoom(ws, roomId, authToken) {
    _releaseFromRoom(ws);  // drop any stale room association (e.g. from auto-reconnect)
    const room = rooms.get(roomId);
    if (!room) { ws.send(JSON.stringify({ type: 'ERROR', msg: 'Room not found' })); return; }

    const payload = verifyAuthPayload(authToken);
    if (!payload) { ws.send(JSON.stringify({ type: 'ERROR', msg: 'Invalid token' })); return; }

    const side = payload.userId === room.homeUserId ? 'home'
               : payload.userId === room.awayUserId ? 'away'
               : null;
    if (!side) { ws.send(JSON.stringify({ type: 'ERROR', msg: 'You are not in this match' })); return; }

    room[side] = ws;
    if (!room.tokens[side]) room.tokens[side] = generateToken();
    ws.send(JSON.stringify({ type: 'ATTACHED', side, roomId: room.id, token: room.tokens[side] }));
    console.log(`Room ${room.id}: ${side} (${payload.username}) attached`);

    // Game already running (rare: a second attach for the same slot) — resync.
    if (room.G) { ws.send(JSON.stringify({ type: 'RECONNECTED', G: room.G, homeTeam: room.homeTeam, awayTeam: room.awayTeam, log: room.log })); return; }

    if (room.home && room.away) startGame(room);
}

function roomOf(ws) {
    for (const room of rooms.values()) {
        if (room.home === ws || room.away === ws) return room;
    }
    return null;
}

function sideOf(room, ws) {
    if (room.home === ws) return 'home';
    if (room.away === ws) return 'away';
    return null;
}

function broadcast(room, msg) {
    // Keep a play-by-play history so a reconnecting client can rebuild the log
    // panel (the log is otherwise client-side only and resets on reload).
    // Entries are { msg, type? }; `type` carries the CSS class for styled lines
    // such as the turn-start markers.
    if (room.log) {
        if (msg.logMsg) room.log.push({ msg: msg.logMsg });

        // Turn-start marker: emitted server-side (rather than in the client's
        // render()) so it lands at the right spot in the history and survives a
        // reconnect. Fires when play begins (kickoff / after a TD) or when the
        // active side changes (end of turn or turnover) — exactly the client's
        // old condition, but now part of the authoritative log.
        const G = room.G;
        if (G && G.phase === 'play') {
            const enteredPlay = room._logPrevPhase !== 'play';
            const sideChanged = !enteredPlay && room._logPrevActive != null && G.active !== room._logPrevActive;
            if (enteredPlay || sideChanged) {
                const marker = { msg: `Turn ${G.turn} · ${G.active.toUpperCase()}`, type: 'turn-marker-' + G.active };
                room.log.push(marker);
                msg.turnMarker = marker;   // live clients render it; render() no longer does (online)
            }
            room._logPrevActive = G.active;
        }
        if (G) room._logPrevPhase = G.phase;

        if (room.log.length > 1000) room.log.splice(0, room.log.length - 1000);
    }
    const text = JSON.stringify(msg);
    if (room.home) room.home.send(text);
    if (room.away) room.away.send(text);
    persistRoom(room);      // snapshot the latest state so it survives a restart
    reportLiveState(room);  // feed the bbauth lobby's "ongoing games" view
}

function reconnectToRoom(ws, roomId, side, token) {
    const room = rooms.get(roomId);
    if (!room || !room.G) {
        ws.send(JSON.stringify({ type: 'RECONNECT_FAILED', msg: 'Room not found or game not started' }));
        return;
    }
    if (!token || token !== room.tokens[side]) {
        ws.send(JSON.stringify({ type: 'RECONNECT_FAILED', msg: 'Invalid token' }));
        return;
    }
    // If the old socket is still open (refresh race condition), overwrite it — it will close on its
    // own and the close handler will be a no-op since roomOf(oldWs) will return null.
    // Clear the countdown and reattach
    clearTimeout(room.reconnectTimer);
    room[side] = ws;
    ws.send(JSON.stringify({ type: 'RECONNECTED', G: room.G, homeTeam: room.homeTeam, awayTeam: room.awayTeam, log: room.log }));
    const other = side === 'home' ? room.away : room.home;
    console.log(`Room ${roomId}: ${side} reconnected — other slot: ${other ? 'present (readyState=' + other.readyState + ')' : 'empty'}`);
    if (other && other.readyState === 1) other.send(JSON.stringify({ type: 'OPPONENT_RECONNECTED', G: room.G }));
}

function destroyRoom(room) {
    clearTimeout(room.registrationTimer);
    clearTimeout(room.reconnectTimer);
    rooms.delete(room.id);
    unpersistRoom(room.id);
    console.log(`Room ${room.id} destroyed`);
}

// ── Result reporting ──────────────────────────────────────────────
// Tell bbauth how a match ended (signed, mirroring the play-token handshake).
// Fired once per room: on the final whistle (status 'completed') or when an
// in-progress game is abandoned (a disconnected player never returns →
// forfeit). A room with no homeUserId is a local/unauth game — nothing to report.

function reportResult(room, status) {
    if (room.reported || !room.G || !room.homeUserId) return;
    const base = process.env.BBAUTH_URL;
    if (!base) return;
    room.reported = true;

    const score = room.G.score || { home: 0, away: 0 };
    let winner;
    if (status === 'abandoned' && room.home && !room.away)      winner = 'home';   // away forfeited
    else if (status === 'abandoned' && room.away && !room.home) winner = 'away';   // home forfeited
    else winner = score.home > score.away ? 'home' : score.away > score.home ? 'away' : 'draw';

    const body = JSON.stringify({
        roomId: room.id, status, score, winner,
        home: { userId: room.homeUserId }, away: { userId: room.awayUserId },
    });
    fetch(`${base}/api/internal/match-result`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-BB-Signature': signBody(body) },
        body,
    })
        .then(r => { if (!r.ok) console.warn(`match-result ${room.id}: bbauth returned ${r.status}`); })
        .catch(e => console.warn(`match-result ${room.id} failed:`, e.message));
}

// Push a live snapshot (score / turn / half / active / phase) to bbauth so the
// lobby can show ongoing games and mark players "in game". Best-effort and
// deduped: only fires when the summary actually changes, so a whole game is a
// handful of POSTs. Skipped for local/unauth games (no homeUserId).
function reportLiveState(room) {
    if (!room.G || !room.homeUserId) return;
    const base = process.env.BBAUTH_URL;
    if (!base) return;

    const G = room.G;
    const summary = {
        score: G.score || { home: 0, away: 0 },
        turn:  G.turn ?? null,
        half:  G.half ?? null,
        active: G.active ?? null,
        phase: G.phase,
    };
    const key = JSON.stringify(summary);
    if (room._liveSummary === key) return;   // nothing meaningful changed
    room._liveSummary = key;

    const body = JSON.stringify({ roomId: room.id, ...summary });
    fetch(`${base}/api/internal/match-update`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-BB-Signature': signBody(body) },
        body,
    }).catch(() => {});   // lobby liveness is non-critical — never let it disrupt the game
}

// ── Game initialisation ───────────────────────────────────────────

function colourEq(a, b) {
    return a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function startGame(room) {
    clearTimeout(room.registrationTimer);   // game is starting — no longer "registered but idle"
    room.log = [];   // fresh play-by-play for the new game
    initFormations();

    room.G = createInitialState();

    const rawHome = room.homeTeamDef || DEFAULT_HOME;
    const rawAway = room.awayTeamDef || DEFAULT_AWAY;

    // Home team always plays in their home colour.
    const homeColour = rawHome.homeColour || rawHome.colour || [180, 40, 40];

    // Away team prefers their home colour too — falls back to away colour only
    // if it would clash with the home team's chosen colour.
    const awayPreferred = rawAway.homeColour || rawAway.colour || [40, 40, 180];
    const awayFallback  = rawAway.awayColour || awayPreferred;
    const awayColour    = colourEq(awayPreferred, homeColour) ? awayFallback : awayPreferred;

    room.homeTeam = { ...rawHome, colour: homeColour };
    room.awayTeam = { ...rawAway, colour: awayColour };

    const homePlayers = TM.buildRosterFromTeam(room.homeTeam, 'home', 0,   FORMATION_HOME);
    const awayPlayers = TM.buildRosterFromTeam(room.awayTeam, 'away', 100, FORMATION_AWAY);
    room.G.players        = [...homePlayers, ...awayPlayers];
    room.G.rerolls         = { home: room.homeTeam.rerolls || 0, away: room.awayTeam.rerolls || 0 };
    room.G.startingRerolls = { ...room.G.rerolls };
    room.G.bribes          = { home: room.homeTeam.bribes  || 0, away: room.awayTeam.bribes  || 0 };
    room.G.cheerleaders    = { home: room.homeTeam.cheerleaders    || 0, away: room.awayTeam.cheerleaders    || 0 };
    room.G.assistantCoaches = { home: room.homeTeam.assistantCoaches || 0, away: room.awayTeam.assistantCoaches || 0 };
    room.G.fanFactor       = { home: room.homeTeam.fanFactor       || 0, away: room.awayTeam.fanFactor       || 0 };
    room.G.apothecary      = { home: !!room.homeTeam.apothecary,         away: !!room.awayTeam.apothecary         };
    initToss(room.G);  // sets phase='toss', picks tossWinner

    console.log(`Room ${room.id}: game started — ${room.G.players.length} players`);

    broadcast(room, {
        type:     'START',
        G:        room.G,
        homeTeam: room.homeTeam,
        awayTeam: room.awayTeam,
    });
}

// ── WebSocket server ──────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

// Heartbeat: ping every 30s and terminate sockets that don't respond.
// This forces a close event for silently-dead connections (mobile NAT
// teardown, etc.) so the room slot is freed and the opponent is notified.
const _heartbeatInterval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) { ws.terminate(); return; }
        ws.isAlive = false;
        ws.ping();
    });
}, 30_000);
wss.on('close', () => clearInterval(_heartbeatInterval));

wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.type === 'ATTACH')      { attachToRoom(ws, msg.roomId, msg.authToken);       return; }
        if (msg.type === 'RECONNECT') {
            if (msg.side !== 'home' && msg.side !== 'away') return;
            reconnectToRoom(ws, msg.roomId, msg.side, msg.token);
            return;
        }

        // ── In-game messages ──

        const room = roomOf(ws);
        if (!room || !room.G) {
            ws.send(JSON.stringify({ type: 'ERROR', msg: 'Not in a game' }));
            return;
        }

        const side = sideOf(room, ws);

        // ── Toss / setup / kick messages (no turn guard needed) ──
        if (msg.type === 'TOSS_CHOOSE')   { handleTossChoose(room, side, msg.choice); return; }
        if (msg.type === 'SETUP_MOVE')         { handleSetupMove(room, side, msg);         return; }
        if (msg.type === 'SETUP_RESERVE_SWAP') { handleSetupReserveSwap(room, side, msg);  return; }
        if (msg.type === 'SETUP_PLAYER_SWAP')  { handleSetupPlayerSwap(room, side, msg);   return; }
        if (msg.type === 'SETUP_DEMOTE')       { handleSetupDemote(room, side, msg);        return; }
        if (msg.type === 'CONFIRM_SETUP') { handleConfirmSetup(room, side);           return; }
        if (msg.type === 'KICK_AIM')                { handleKickAim(room, side, msg);                return; }
        if (msg.type === 'TOUCHBACK')               { handleTouchback(room, side, msg);              return; }
        if (msg.type === 'SOLID_DEFENCE_MOVE')      { handleSolidDefenceMove(room, side, msg);       return; }
        if (msg.type === 'SOLID_DEFENCE_DEMOTE')    { handleSolidDefenceDemote(room, side, msg);     return; }
        if (msg.type === 'SOLID_DEFENCE_CONFIRM')   { handleSolidDefenceConfirm(room, side);         return; }
        if (msg.type === 'QUICKSNAP_MOVE')          { handleQuickSnapMove(room, side, msg);          return; }
        if (msg.type === 'QUICKSNAP_CONFIRM')       { handleQuickSnapConfirm(room, side);            return; }
        if (msg.type === 'CHARGE_CONFIRM')          { handleChargeConfirm(room, side);               return; }
        if (msg.type === 'HIGHKICK_PLACE')          { handleHighKickPlace(room, side, msg);          return; }
        if (msg.type === 'HIGHKICK_SKIP')           { handleHighKickSkip(room, side);                return; }

        if (msg.type === 'DEBUG_MOVE_PLAYER') { handleDebugMovePlayer(room, msg); return; }
        if (msg.type === 'DEBUG_MOVE_BALL')   { handleDebugMoveBall(room, msg);   return; }
        if (msg.type === 'DEBUG_SET_SKILLS')  { handleDebugSetSkills(room, msg);  return; }

        // Reaction choices can belong to the defending (non-active) coach, so they
        // bypass the turn guard; each is then side-checked via gc in handleAction.
        const turnFree = ['BLOCK_FACE', 'BLOCK_PUSH', 'FOLLOW_UP', 'CHOOSE_INTERCEPTOR',
                          'FEND', 'STAND_FIRM', 'STRIP_BALL', 'WRESTLE', 'JUGGERNAUT',
                          'DIVING_TACKLE'].includes(msg.type);
        if (!turnFree && side !== room.G.active) {
            ws.send(JSON.stringify({ type: 'ERROR', msg: 'Not your turn' }));
            return;
        }

        console.log(`Room ${room.id} · ${side}: ${msg.type}`);
        // Never let one bad action take down the whole server (and every other
        // game with it). On an engine error, log it and tell just this client.
        try {
            handleAction(room, msg, side);
            // Turnover during Charge! — auto-resolve the kick in the same broadcast
            {
                const G = room.G;
                if (G.phase === 'kickoff_charge' && G.chargeMovesLeft === 0 && !G.activated) {
                    G.players.forEach(p => { if (p.side === G.kicker) { p.usedAction = false; p.maLeft = p.ma; p.rushLeft = 2; } });
                    const col = G.pendingKick?.col;
                    const row = G.pendingKick?.row;
                    G.phase = 'kick';
                    const scatterMsg = resolveKickScatter(G, col, row);
                    if (scatterMsg) room.lastLogMsg = (room.lastLogMsg ? room.lastLogMsg + ' ' : '') + scatterMsg;
                }
            }
            broadcast(room, { type: 'UPDATE', G: room.G, logMsg: room.lastLogMsg });
            room.lastLogMsg = null;
            if (room.G.phase === 'gameover') reportResult(room, 'completed');
        } catch (err) {
            console.error(`Room ${room.id}: action ${msg.type} threw —`, err.stack || err.message);
            try { ws.send(JSON.stringify({ type: 'ERROR', msg: 'That action failed on the server.' })); } catch {}
        }
    });

    ws.on('close', () => {
        const room = roomOf(ws);
        if (!room) return;
        const side = sideOf(room, ws);

        // If a new socket already took this slot (reconnect race), do nothing
        if (room[side] !== ws) return;

        console.log(`Room ${room.id}: ${side} disconnected`);

        // Null out the socket but keep the room alive for 2 minutes
        room[side] = null;
        const other = side === 'home' ? room.away : room.home;
        if (other) other.send(JSON.stringify({ type: 'OPPONENT_DISCONNECTED' }));

        clearTimeout(room.reconnectTimer);
        room.reconnectTimer = setTimeout(() => {
            console.log(`Room ${room.id}: reconnect timeout — destroying`);
            reportResult(room, 'abandoned');   // forfeit to whoever is still here (no-op if already completed)
            if (room.home) room.home.send(JSON.stringify({ type: 'ERROR', msg: 'Opponent did not reconnect' }));
            if (room.away) room.away.send(JSON.stringify({ type: 'ERROR', msg: 'Opponent did not reconnect' }));
            destroyRoom(room);
        }, 120_000);
    });
});

// ── Toss / setup handlers ─────────────────────────────────────────

function handleTossChoose(room, side, choice) {
    const G = room.G;
    if (G.phase !== 'toss') return;
    if (side !== G.tossWinner) return;  // only the winner chooses
    const logMsg = chooseTossResult(G, choice);
    broadcast(room, { type: 'UPDATE', G, logMsg });
}

function handleSetupMove(room, side, msg) {
    const G = room.G;
    if (G.phase !== 'setup' || side !== G.setupSide) return;
    moveSetupPlayer(G, msg.playerId, msg.col, msg.row);
    broadcast(room, { type: 'UPDATE', G, logMsg: null });
}

function handleSetupReserveSwap(room, side, msg) {
    const G = room.G;
    if (G.phase !== 'setup' || side !== G.setupSide) return;
    swapReservePlayer(G, msg.reserveId, msg.pitchId);
    broadcast(room, { type: 'UPDATE', G, logMsg: null });
}

function handleSetupPlayerSwap(room, side, msg) {
    const G = room.G;
    if (G.phase !== 'setup' || side !== G.setupSide) return;
    swapSetupPlayers(G, msg.id1, msg.id2);
    broadcast(room, { type: 'UPDATE', G, logMsg: null });
}

function handleSetupDemote(room, side, msg) {
    const G = room.G;
    if (G.phase !== 'setup' || side !== G.setupSide) return;
    demoteToReserve(G, msg.playerId);
    broadcast(room, { type: 'UPDATE', G, logMsg: null });
}

function handleKickAim(room, side, msg) {
    const G = room.G;
    if (G.phase !== 'kick' || side !== G.kicker) return;
    const logMsg = declareKick(G, msg.col, msg.row);
    if (logMsg) broadcast(room, { type: 'UPDATE', G, logMsg });
}

function handleTouchback(room, side, msg) {
    const G = room.G;
    if (G.phase !== 'touchback' && G.phase !== 'kickoff_touchback') return;
    if (side !== G.receiver) return;
    const logMsg = touchbackGiveBall(G, msg.playerId);
    if (logMsg) broadcast(room, { type: 'UPDATE', G, logMsg });
}

// ── Kickoff event handlers ────────────────────────────────────────

function handleSolidDefenceMove(room, side, msg) {
    const G = room.G;
    if (G.phase !== 'kickoff_soliddefence' || side !== G.kicker) return;
    moveSolidDefencePlayer(G, msg.playerId, msg.col, msg.row);
    broadcast(room, { type: 'UPDATE', G, logMsg: null });
}

function handleSolidDefenceDemote(room, side, msg) {
    const G = room.G;
    if (G.phase !== 'kickoff_soliddefence' || side !== G.kicker) return;
    demoteSolidDefencePlayer(G, msg.playerId);
    broadcast(room, { type: 'UPDATE', G, logMsg: null });
}

function handleSolidDefenceConfirm(room, side) {
    const G = room.G;
    if (G.phase !== 'kickoff_soliddefence' || side !== G.kicker) return;
    const errors = validateSetup(G, G.kicker);
    if (errors.length) {
        const ws = room[side];
        if (ws) ws.send(JSON.stringify({ type: 'UPDATE', G, logMsg: errors[0], setupError: true }));
        return;
    }
    G.setupSide = null;
    G.phase = 'kick';
    G.players.forEach(p => { delete p.sdSelected; });
    const logMsg = resolveKickScatter(G);
    broadcast(room, { type: 'UPDATE', G, logMsg });
}

function handleQuickSnapMove(room, side, msg) {
    const G = room.G;
    if (G.phase !== 'kickoff_quicksnap' || side !== G.receiver) return;
    kickoffQuickSnapMove(G, msg.playerId, msg.col, msg.row);
    broadcast(room, { type: 'UPDATE', G, logMsg: null });
}

function handleQuickSnapConfirm(room, side) {
    const G = room.G;
    if (G.phase !== 'kickoff_quicksnap' || side !== G.receiver) return;
    G.phase = 'kick';
    const logMsg = resolveKickScatter(G);
    broadcast(room, { type: 'UPDATE', G, logMsg });
}

function handleChargeConfirm(room, side) {
    const G = room.G;
    if (G.phase !== 'kickoff_charge' || side !== G.kicker) return;
    if (G.activated) { G.activated.usedAction = true; G.activated = null; }
    G.blitz = null; G.hasBlitzed = false; G.chargeMovesLeft = 0;
    G.players.forEach(p => { if (p.side === G.kicker) { p.usedAction = false; p.maLeft = p.ma; p.rushLeft = 2; } });
    G.phase = 'kick';
    const logMsg = resolveKickScatter(G);
    broadcast(room, { type: 'UPDATE', G, logMsg });
}

function handleHighKickPlace(room, side, msg) {
    const G = room.G;
    if (G.phase !== 'kickoff_highkick' || side !== G.receiver) return;
    const logMsg = highKickPlace(G, msg.playerId);
    if (logMsg) broadcast(room, { type: 'UPDATE', G, logMsg });
}

function handleHighKickSkip(room, side) {
    const G = room.G;
    if (G.phase !== 'kickoff_highkick' || side !== G.receiver) return;
    const logMsg = skipHighKick(G);
    if (logMsg) broadcast(room, { type: 'UPDATE', G, logMsg });
}

function handleConfirmSetup(room, side) {
    const G = room.G;
    if (G.phase !== 'setup' || side !== G.setupSide) return;
    const result = confirmSetup(G, side);
    if (!result) return;
    const logMsg    = result.errors ? result.errors[0] : result.msg;
    const setupError = !!result.errors;
    if (setupError) {
        const ws = room[side];
        if (ws) ws.send(JSON.stringify({ type: 'UPDATE', G, logMsg, setupError }));
    } else {
        broadcast(room, { type: 'UPDATE', G, logMsg, setupError });
    }
}

// ── Debug action handlers ─────────────────────────────────────────

function handleDebugMovePlayer(room, msg) {
    const G = room.G;
    const p = G.players.find(p => p.id === msg.playerId);
    if (!p || msg.col < 0 || msg.col >= COLS || msg.row < 0 || msg.row >= ROWS) return;
    const occupant = playerAt(G, msg.col, msg.row);
    if (occupant && occupant.id !== p.id) {
        const c = occupant.col, r = occupant.row;
        occupant.col = p.col; occupant.row = p.row;
        p.col = c;            p.row = r;
    } else if (!occupant) {
        p.col = msg.col; p.row = msg.row;
    }
    if (p.hasBall) { G.ball.col = p.col; G.ball.row = p.row; }
    broadcast(room, { type: 'UPDATE', G });
}

function handleDebugMoveBall(room, msg) {
    const G = room.G;
    if (G.ball.carrier) { G.ball.carrier.hasBall = false; G.ball.carrier = null; }
    if (msg.carrierId !== undefined) {
        const carrier = G.players.find(p => p.id === msg.carrierId);
        if (!carrier) return;
        G.ball.carrier = carrier;
        carrier.hasBall = true;
        G.ball.col = carrier.col;
        G.ball.row = carrier.row;
    } else {
        if (msg.col < 0 || msg.col >= COLS || msg.row < 0 || msg.row >= ROWS) return;
        G.ball.col = msg.col;
        G.ball.row = msg.row;
    }
    broadcast(room, { type: 'UPDATE', G });
}

function handleDebugSetSkills(room, msg) {
    const G = room.G;
    const p = G.players.find(p => p.id === msg.playerId);
    if (!p) return;
    p.skills = msg.skills;
    broadcast(room, { type: 'UPDATE', G });
}

// ── Action handler ────────────────────────────────────────────────

function handleAction(room, msg, side) {
    const G  = room.G;
    const sel = G.players.find(p => p.id === msg.playerId) ?? null;
    // Use the real sender side so the canUse* gating enforces who may act —
    // crucial for reaction choices (Wrestle/Fend/Stand Firm/Diving Tackle) that
    // belong to the defending (non-active) coach.
    const gc  = getGameContext(G, sel, { online: true, side });
    switch (msg.type) {
        case 'ACTIVATE':      if (!gc.canDeclare) return; room.lastLogMsg = activateMover(G, msg.playerId);      break;
        case 'ACTIVATE_AND_MOVE': {
            if (!gc.canDeclare) return;
            const aMsg = activateMover(G, msg.playerId);
            if (aMsg) room.lastLogMsg = aMsg;
            if (G.activated && !G.animalSavagery) {
                const mMsg = movePlayer(G, msg.col, msg.row);
                if (mMsg) room.lastLogMsg = (room.lastLogMsg ? room.lastLogMsg + ' ' : '') + mMsg;
            }
            break;
        }
        case 'MOVE':          room.lastLogMsg = movePlayer(G, msg.col, msg.row);     break;
        case 'CANCEL':        room.lastLogMsg = cancelActivation(G);                 break;
        case 'STOP':          room.lastLogMsg = endActivation(G);                    break;
        case 'END_TURN':      endTurn(G); room.lastLogMsg = null; break;
        case 'SECURE_BALL':   if (!gc.canSecure)  return; room.lastLogMsg = secureBall(G, msg.playerId);         break;
        case 'FOUL_DECLARE':        if (!gc.canFoul)    return; room.lastLogMsg = declareFoul(G, msg.playerId);           break;
        case 'DO_FOUL':             room.lastLogMsg = executeFoul(G, msg.targetId);           break;
        case 'ARGUE_CALL':          room.lastLogMsg = resolveArgueCall(G, msg.use);           break;
        case 'BRIBE':               room.lastLogMsg = resolveBribe(G, msg.use);              break;
        case 'HANDOFF_DECLARE':     if (!gc.canHandoff) return; room.lastLogMsg = declareHandoff(G, msg.playerId);       break;
        case 'DO_HANDOFF':          room.lastLogMsg = doHandoff(G, msg.receiverId);          break;
        case 'PASS_DECLARE':        if (!gc.canPass)    return; room.lastLogMsg = declarePass(G, msg.playerId);          break;
        case 'THROW_BALL':          room.lastLogMsg = throwBall(G, msg.col, msg.row);        break;
        case 'PASS_REROLL':         room.lastLogMsg = resolvePassReroll(G, msg.use);         break;
        case 'TEAM_REROLL':         room.lastLogMsg = useTeamReroll(G);                      break;
        case 'DECLINE_TEAM_REROLL': room.lastLogMsg = declineTeamReroll(G);                  break;
        case 'CHOOSE_INTERCEPTOR':  room.lastLogMsg = chooseInterceptor(G, msg.playerId);    break;
        case 'BLITZ_DECLARE': if (!gc.canBlitz)   return; room.lastLogMsg = activateBlitz(G, msg.playerId);      break;
        case 'BLITZ_TARGET':  room.lastLogMsg = setBlitzTarget(G, msg.defId);        break;
        case 'BLITZ_START': {
            const att = G.players.find(p => p.id === msg.attId);
            const def = G.players.find(p => p.id === msg.defId);
            if (att && def) room.lastLogMsg = blitzBlock(G, att, def);
            break;
        }
        case 'BLOCK_START': {
            const att = G.players.find(p => p.id === msg.attId);
            const def = G.players.find(p => p.id === msg.defId);
            if (att && def) room.lastLogMsg = declareBlock(G, att, def);
            break;
        }
        case 'BLOCK_FACE': {
            if (G.block && G.block.phase === 'pick-face') {
                const idx = msg.faceIdx;
                if (!Number.isInteger(idx) || idx < 0 || idx >= G.block.rolls.length) break;
                const face = G.block.rolls[idx];
                if (face) room.lastLogMsg = pickBlockFace(G, face);
            }
            break;
        }
        case 'BLOCK_REROLL':      if (!gc.canRerollBlock) return; room.lastLogMsg = rerollBlockDice(G);          break;
        case 'BLOCK_PRO_DECLARE': if (!gc.canProBlock)    return; room.lastLogMsg = declareProBlock(G);          break;
        case 'BLOCK_PRO_DIE':     room.lastLogMsg = proBlockRerollDie(G, msg.dieIdx);                            break;
        case 'BLOCK_PUSH': {
            if (G.block && G.block.phase === 'pick-push')
                room.lastLogMsg = pickPushSquare(G, msg.col, msg.row);
            break;
        }
        case 'FOLLOW_UP':   room.lastLogMsg = resolveFollowUp(G, msg.choice);         break;
        case 'FEND':        if (!gc.canUseFend)         return; room.lastLogMsg = resolveFend(G, msg.use);          break;
        case 'STAND_FIRM':  if (!gc.canUseStandFirm)    return; room.lastLogMsg = resolveStandFirm(G, msg.use);     break;
        case 'STRIP_BALL':  if (!gc.canUseStripBall)    return; room.lastLogMsg = resolveStripBall(G, msg.use);     break;
        case 'WRESTLE':     if (!gc.canUseWrestle)      return; room.lastLogMsg = resolveWrestle(G, msg.use);       break;
        case 'JUGGERNAUT':  if (!gc.canUseJuggernaut)   return; room.lastLogMsg = resolveJuggernaut(G, msg.use);    break;
        case 'DIVING_TACKLE': if (!gc.canUseDivingTackle) return; room.lastLogMsg = resolveDivingTackle(G, msg.use); break;
        case 'AS_PICK_TARGET': room.lastLogMsg = resolveASHit(G, msg.targetId);       break;
        case 'PV_DECLARE':  if (!gc.canDeclarePV)  return; room.lastLogMsg = declarePV(G, msg.playerId);       break;
        case 'PV_EXECUTE':  room.lastLogMsg = executePV(G, msg.targetId);             break;
        case 'STAB_DECLARE': if (!gc.canDeclareStab) return; room.lastLogMsg = declareStab(G, msg.playerId);   break;
        case 'STAB_EXECUTE': room.lastLogMsg = executeStab(G, msg.targetId);          break;
        case 'TTM_DECLARE': if (!gc.canDeclareTTM) return; room.lastLogMsg = declareTTM(G, msg.playerId);      break;
        case 'TTM_PICK_MISSILE': room.lastLogMsg = pickTTMMissile(G, msg.missileId);  break;
        case 'TTM_THROW':   room.lastLogMsg = throwTeamMate(G, msg.col, msg.row);     break;
    }
}

// ── Start listening ───────────────────────────────────────────────

// Last-resort safety net: keep the server (and every other game) alive if an
// error escapes a timer or callback. Active games are persisted, so even a
// genuinely bad state is recoverable on reconnect.
process.on('uncaughtException',  (err) => console.error('Uncaught exception (server kept alive):', err.stack || err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection (server kept alive):', err));

const PORT = process.env.PORT || 3000;
loadPersistedRooms();   // restore any games left active by a previous run
httpServer.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

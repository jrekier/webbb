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
    moveSetupPlayer, demoteToReserve, swapReservePlayer, swapSetupPlayers, confirmSetup,
    cancelActivation, endActivation, endTurn,
} = require('./public/engine/core.js');
const {
    activateMover, movePlayer,
    activateBlitz, setBlitzTarget, blitzBlock,
    declareBlock, pickBlockFace, pickPushSquare, resolveFollowUp,
    declareFoul, executeFoul, resolveArgueCall,
    declareHandoff, doHandoff,
    declarePass, throwBall, resolvePassReroll, chooseInterceptor,
    declareKick, touchbackGiveBall, secureBall,
} = require('./public/engine/actions.js');
const TM = require('./public/engine/teams.js');
const { getGameContext } = require('./public/engine/truth.js');

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

    const filePath = pathname === '/' ? '/index.html' : pathname;
    const fullPath = path.resolve(PUB_DIR, '.' + filePath);
    if (!fullPath.startsWith(PUB_DIR + path.sep)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    const ext      = path.extname(fullPath);
    const mimeType = MIME_TYPES[ext] || 'text/plain';

    fs.readFile(fullPath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }

        if (filePath === '/index.html' && STATIC_URL) {
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
// Verifies a token issued by bbauth and returns the teamDef, or null.

function verifyAuthToken(raw) {
    if (!raw || !process.env.SHARED_SECRET) return null;
    try {
        const [payload, sig] = raw.split('.');
        const expected = crypto.createHmac('sha256', process.env.SHARED_SECRET).update(payload).digest('hex');
        if (sig !== expected) return null;
        const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
        if (data.exp < Math.floor(Date.now() / 1000)) return null;
        return data.teamDef || null;
    } catch { return null; }
}

// ── Default teams ─────────────────────────────────────────────────

function loadTeamDef(filename) {
    const raw = fs.readFileSync(path.join(__dirname, 'public', filename), 'utf8');
    return JSON.parse(raw);
}

const DEFAULT_HOME = loadTeamDef('team-humans.json');
const DEFAULT_AWAY = loadTeamDef('team-orcs.json');

// ── Lobby ─────────────────────────────────────────────────────────
// Clients in the lobby are waiting to create or join a room.

const lobby = new Set();  // WebSocket connections currently in the lobby

function enterLobby(ws) {
    lobby.add(ws);
    sendLobbyState(ws);
}

function leaveLobby(ws) {
    lobby.delete(ws);
}

function lobbySnapshot() {
    // Only expose what the lobby needs to display
    return Array.from(rooms.values()).map(r => ({
        id:     r.id,
        status: r.G ? 'playing' : 'waiting',
    }));
}

function sendLobbyState(ws) {
    ws.send(JSON.stringify({ type: 'LOBBY_UPDATE', rooms: lobbySnapshot() }));
}

function broadcastLobbyUpdate() {
    const msg = JSON.stringify({ type: 'LOBBY_UPDATE', rooms: lobbySnapshot() });
    for (const ws of lobby) ws.send(msg);
}

// ── Room manager ──────────────────────────────────────────────────
// Each room is fully isolated: own game state, own sockets.

const rooms = new Map();

// Joins that arrived before the room was created (race condition:
// away player connects faster than home player).
// roomId → { ws, authToken, timer }
const pendingJoins = new Map();

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

function createRoom(ws, authToken, preassignedRoomId) {
    _releaseFromRoom(ws);  // drop any stale room association (e.g. from auto-reconnect)
    const id = (preassignedRoomId && !rooms.has(preassignedRoomId))
        ? preassignedRoomId
        : generateRoomId();
    const homeToken = generateToken();
    const room      = { id, home: ws, away: null, G: null, lastLogMsg: null, tokens: { home: homeToken, away: null },
                        homeTeamDef: verifyAuthToken(authToken) || null, awayTeamDef: null };
    rooms.set(id, room);
    leaveLobby(ws);
    ws.send(JSON.stringify({ type: 'ROOM_CREATED', side: 'home', roomId: id, token: homeToken }));
    console.log(`Room ${id} created`);
    broadcastLobbyUpdate();

    // If the away player connected first (race condition), complete their join now.
    const pending = pendingJoins.get(id);
    if (pending) {
        pendingJoins.delete(id);
        clearTimeout(pending.timer);
        _doJoinRoom(pending.ws, room, pending.authToken);
    }

    return room;
}

function _doJoinRoom(ws, room, authToken) {
    if (room.away) return ws.send(JSON.stringify({ type: 'ERROR', msg: 'Room is full' }));
    const awayToken  = generateToken();
    room.away        = ws;
    room.tokens.away = awayToken;
    room.awayTeamDef = verifyAuthToken(authToken) || null;
    leaveLobby(ws);
    // Tell away player their side before START arrives so NET.side is set in time
    ws.send(JSON.stringify({ type: 'ROOM_JOINED', side: 'away', roomId: room.id, token: awayToken }));
    console.log(`Room ${room.id}: away joined — starting game`);
    startGame(room);
    broadcastLobbyUpdate();
}

function joinRoom(ws, roomId, authToken) {
    _releaseFromRoom(ws);  // drop any stale room association
    const room = rooms.get(roomId);
    if (room) return _doJoinRoom(ws, room, authToken);

    // Room doesn't exist yet — home player may still be loading.
    // Queue the join for up to 8 seconds before giving up.
    const existing = pendingJoins.get(roomId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
        pendingJoins.delete(roomId);
        ws.send(JSON.stringify({ type: 'ERROR', msg: 'Room not found' }));
    }, 8000);
    pendingJoins.set(roomId, { ws, authToken, timer });
    console.log(`Room ${roomId}: JOIN queued (room not yet created)`);
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
    const text = JSON.stringify(msg);
    if (room.home) room.home.send(text);
    if (room.away) room.away.send(text);
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
    ws.send(JSON.stringify({ type: 'RECONNECTED', G: room.G, homeTeam: room.homeTeam, awayTeam: room.awayTeam }));
    const other = side === 'home' ? room.away : room.home;
    console.log(`Room ${roomId}: ${side} reconnected — other slot: ${other ? 'present (readyState=' + other.readyState + ')' : 'empty'}`);
    if (other && other.readyState === 1) other.send(JSON.stringify({ type: 'OPPONENT_RECONNECTED', G: room.G }));
}

function destroyRoom(room) {
    rooms.delete(room.id);
    console.log(`Room ${room.id} destroyed`);
    broadcastLobbyUpdate();
}

// ── Game initialisation ───────────────────────────────────────────

function colourEq(a, b) {
    return a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function startGame(room) {
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
    room.G.players = [...homePlayers, ...awayPlayers];
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

        if (msg.type === 'ENTER_LOBBY') { enterLobby(ws);                                    return; }
        if (msg.type === 'CREATE_ROOM') { createRoom(ws, msg.authToken, msg.roomId);         return; }
        if (msg.type === 'JOIN_ROOM')   { joinRoom(ws, msg.roomId, msg.authToken);          return; }
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
        if (msg.type === 'KICK_AIM')      { handleKickAim(room, side, msg);           return; }
        if (msg.type === 'TOUCHBACK')     { handleTouchback(room, side, msg);         return; }

        const turnFree = ['BLOCK_FACE', 'BLOCK_PUSH', 'FOLLOW_UP', 'CHOOSE_INTERCEPTOR'].includes(msg.type);
        if (!turnFree && side !== room.G.active) {
            ws.send(JSON.stringify({ type: 'ERROR', msg: 'Not your turn' }));
            return;
        }

        console.log(`Room ${room.id} · ${side}: ${msg.type}`);
        handleAction(room, msg);
        broadcast(room, { type: 'UPDATE', G: room.G, logMsg: room.lastLogMsg });
        room.lastLogMsg  = null;
    });

    ws.on('close', () => {
        leaveLobby(ws);
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
    if (G.phase !== 'touchback' || side !== G.receiver) return;
    const logMsg = touchbackGiveBall(G, msg.playerId);
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

// ── Action handler ────────────────────────────────────────────────

function handleAction(room, msg) {
    const G  = room.G;
    const sel = G.players.find(p => p.id === msg.playerId) ?? null;
    const gc  = getGameContext(G, sel, { online: false });
    switch (msg.type) {
        case 'ACTIVATE':      if (!gc.canDeclare) return; room.lastLogMsg = activateMover(G, msg.playerId);      break;
        case 'ACTIVATE_AND_MOVE': {
            if (!gc.canDeclare) return;
            const aMsg = activateMover(G, msg.playerId);
            if (aMsg) room.lastLogMsg = aMsg;
            if (G.activated) {
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
        case 'HANDOFF_DECLARE':     if (!gc.canHandoff) return; room.lastLogMsg = declareHandoff(G, msg.playerId);       break;
        case 'DO_HANDOFF':          room.lastLogMsg = doHandoff(G, msg.receiverId);          break;
        case 'PASS_DECLARE':        if (!gc.canPass)    return; room.lastLogMsg = declarePass(G, msg.playerId);          break;
        case 'THROW_BALL':          room.lastLogMsg = throwBall(G, msg.col, msg.row);        break;
        case 'PASS_REROLL':         room.lastLogMsg = resolvePassReroll(G, msg.use);         break;
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
        case 'BLOCK_PUSH': {
            if (G.block && G.block.phase === 'pick-push')
                room.lastLogMsg = pickPushSquare(G, msg.col, msg.row);
            break;
        }
        case 'FOLLOW_UP': {
            room.lastLogMsg = resolveFollowUp(G, msg.choice);
            break;
        }
    }
}

// ── Start listening ───────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

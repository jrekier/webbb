'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const {
    createInitialState, initFormations, FORMATION_HOME, FORMATION_AWAY,
    initToss, chooseTossResult,
    moveSetupPlayer, confirmSetup,
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

const httpServer = http.createServer((req, res) => {
    const rawPath  = req.url.split('?')[0];
    const filePath = rawPath === '/' ? '/index.html' : rawPath;
    const fullPath = path.join(__dirname, 'public', path.normalize(filePath));
    if (!fullPath.startsWith(path.join(__dirname, 'public') + path.sep)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }
    const ext      = path.extname(fullPath);
    const mimeType = MIME_TYPES[ext] || 'text/plain';

    fs.readFile(fullPath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': mimeType });
        res.end(data);
    });
});

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

function createRoom(ws) {
    _releaseFromRoom(ws);  // drop any stale room association (e.g. from auto-reconnect)
    const id        = generateRoomId();
    const homeToken = generateToken();
    const room      = { id, home: ws, away: null, G: null, lastLogMsg: null, tokens: { home: homeToken, away: null } };
    rooms.set(id, room);
    leaveLobby(ws);
    ws.send(JSON.stringify({ type: 'ROOM_CREATED', side: 'home', roomId: id, token: homeToken }));
    console.log(`Room ${id} created`);
    broadcastLobbyUpdate();
    return room;
}

function joinRoom(ws, roomId) {
    _releaseFromRoom(ws);  // drop any stale room association
    const room = rooms.get(roomId);
    if (!room)       return ws.send(JSON.stringify({ type: 'ERROR', msg: 'Room not found' }));
    if (room.away)   return ws.send(JSON.stringify({ type: 'ERROR', msg: 'Room is full' }));
    const awayToken   = generateToken();
    room.away         = ws;
    room.tokens.away  = awayToken;
    leaveLobby(ws);
    // Tell away player their side before START arrives so NET.side is set in time
    ws.send(JSON.stringify({ type: 'ROOM_JOINED', side: 'away', roomId, token: awayToken }));
    console.log(`Room ${roomId}: away joined — starting game`);
    startGame(room);
    broadcastLobbyUpdate();
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

function startGame(room) {
    initFormations();

    room.G        = createInitialState();
    room.homeTeam = DEFAULT_HOME;
    room.awayTeam = DEFAULT_AWAY;

    const homePlayers = TM.buildRosterFromTeam(DEFAULT_HOME, 'home', 0,   FORMATION_HOME);
    const awayPlayers = TM.buildRosterFromTeam(DEFAULT_AWAY, 'away', 100, FORMATION_AWAY);
    room.G.players = [...homePlayers, ...awayPlayers];
    initToss(room.G);  // sets phase='toss', picks tossWinner

    console.log(`Room ${room.id}: game started — ${room.G.players.length} players`);

    broadcast(room, {
        type:     'START',
        G:        room.G,
        homeTeam: DEFAULT_HOME,
        awayTeam: DEFAULT_AWAY,
    });
}

// ── WebSocket server ──────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.type === 'ENTER_LOBBY') { enterLobby(ws);              return; }
        if (msg.type === 'CREATE_ROOM') { createRoom(ws);              return; }
        if (msg.type === 'JOIN_ROOM')   { joinRoom(ws, msg.roomId);    return; }
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
        if (msg.type === 'SETUP_MOVE')    { handleSetupMove(room, side, msg);         return; }
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
        room.lastLogMsg = null;
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
    broadcast(room, { type: 'UPDATE', G, logMsg, setupError });
}

// ── Action handler ────────────────────────────────────────────────

function handleAction(room, msg) {
    const G  = room.G;
    const sel = G.players.find(p => p.id === msg.playerId) ?? null;
    const gc  = getGameContext(G, sel, { online: false });
    switch (msg.type) {
        case 'ACTIVATE':      if (!gc.canDeclare) return; room.lastLogMsg = activateMover(G, msg.playerId);      break;
        case 'MOVE':          room.lastLogMsg = movePlayer(G, msg.col, msg.row);     break;
        case 'CANCEL':        room.lastLogMsg = cancelActivation(G);                 break;
        case 'STOP':          room.lastLogMsg = endActivation(G);                    break;
        case 'END_TURN':      room.lastLogMsg = endTurn(G);                          break;
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

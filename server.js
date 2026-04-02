'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const GL = require('./engine/logic.js');
const TM = require('./engine/teams.js');

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
    const filePath = req.url === '/' ? '/index.html' : req.url;
    const fullPath = path.join(__dirname, filePath);
    const ext      = path.extname(filePath);
    const mimeType = MIME_TYPES[ext] || 'text/plain';

    fs.readFile(fullPath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': mimeType });
        res.end(data);
    });
});

// ── Rulesets ─────────────────────────────────────────────────────

const RULESETS = {
    sevens: {
        name: 'Blood Bowl Sevens',
        COLS: 11, ROWS: 20, TURNS: 6,
        END_ZONE_HOME: 19, END_ZONE_AWAY: 0,
        SCR_HOME: 12, SCR_AWAY: 7,
        WIDE_COLS: [0,1,9,10],
        PLAYERS_PER_TEAM: 7,
    },
    classic: {
        name: 'Blood Bowl',
        COLS: 15, ROWS: 26, TURNS: 8,
        END_ZONE_HOME: [24,25], END_ZONE_AWAY: [0,1],
        SCR_HOME: 13, SCR_AWAY: 12,
        WIDE_COLS: [0,1,2,12,13,14],
        PLAYERS_PER_TEAM: 11,
    },
};

// ── Default teams ─────────────────────────────────────────────────

function loadTeamDef(filename) {
    const raw = fs.readFileSync(path.join(__dirname, filename), 'utf8');
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

function createRoom(ws) {
    const id   = generateRoomId();
    const room = { id, home: ws, away: null, G: null, lastLogMsg: null };
    rooms.set(id, room);
    leaveLobby(ws);
    ws.send(JSON.stringify({ type: 'ROOM_CREATED', side: 'home', roomId: id }));
    console.log(`Room ${id} created`);
    broadcastLobbyUpdate();
    return room;
}

function joinRoom(ws, roomId) {
    const room = rooms.get(roomId);
    if (!room)       return ws.send(JSON.stringify({ type: 'ERROR', msg: 'Room not found' }));
    if (room.away)   return ws.send(JSON.stringify({ type: 'ERROR', msg: 'Room is full' }));
    room.away = ws;
    leaveLobby(ws);
    // Tell away player their side before START arrives so NET.side is set in time
    ws.send(JSON.stringify({ type: 'ROOM_JOINED', side: 'away', roomId }));
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

function reconnectToRoom(ws, roomId, side) {
    const room = rooms.get(roomId);
    if (!room || !room.G) {
        ws.send(JSON.stringify({ type: 'RECONNECT_FAILED', msg: 'Room not found or game not started' }));
        return;
    }
    if (room[side] !== null) {
        ws.send(JSON.stringify({ type: 'RECONNECT_FAILED', msg: 'Slot already occupied' }));
        return;
    }
    // Clear the countdown and reattach
    clearTimeout(room.reconnectTimer);
    room[side] = ws;
    ws.send(JSON.stringify({ type: 'RECONNECTED', G: room.G }));
    const other = side === 'home' ? room.away : room.home;
    if (other) other.send(JSON.stringify({ type: 'RECONNECTED', G: room.G }));
    console.log(`Room ${roomId}: ${side} reconnected`);
}

function destroyRoom(room) {
    rooms.delete(room.id);
    console.log(`Room ${room.id} destroyed`);
    broadcastLobbyUpdate();
}

// ── Game initialisation ───────────────────────────────────────────

function startGame(room, rulesetKey) {
    rulesetKey    = rulesetKey || 'sevens';
    const ruleset = RULESETS[rulesetKey];

    global.COLS = ruleset.COLS;
    global.ROWS = ruleset.ROWS;

    GL.initFormations(rulesetKey);

    room.G = GL.createInitialState();

    const homePlayers = TM.buildRosterFromTeam(DEFAULT_HOME, 'home', 0,   GL.FORMATION_HOME);
    const awayPlayers = TM.buildRosterFromTeam(DEFAULT_AWAY, 'away', 100, GL.FORMATION_AWAY);
    room.G.players            = [...homePlayers, ...awayPlayers];
    room.G.players[1].hasBall = true;
    room.G.ball.carrier       = room.G.players[1];

    console.log(`Room ${room.id}: game started — ${room.G.players.length} players`);

    broadcast(room, {
        type:     'START',
        G:        room.G,
        homeTeam: DEFAULT_HOME,
        awayTeam: DEFAULT_AWAY,
        ruleset:  rulesetKey,
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
        if (msg.type === 'RECONNECT')   { reconnectToRoom(ws, msg.roomId, msg.side); return; }

        // ── In-game messages ──

        const room = roomOf(ws);
        if (!room || !room.G) {
            ws.send(JSON.stringify({ type: 'ERROR', msg: 'Not in a game' }));
            return;
        }

        const side     = sideOf(room, ws);
        const turnFree = ['BLOCK_FACE', 'BLOCK_PUSH', 'FOLLOW_UP'].includes(msg.type);
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
        console.log(`Room ${room.id}: ${side} disconnected`);

        // Null out the socket but keep the room alive for 2 minutes
        room[side] = null;
        const other = side === 'home' ? room.away : room.home;
        if (other) other.send(JSON.stringify({ type: 'OPPONENT_DISCONNECTED' }));

        room.reconnectTimer = setTimeout(() => {
            console.log(`Room ${room.id}: reconnect timeout — destroying`);
            if (room.home) room.home.send(JSON.stringify({ type: 'ERROR', msg: 'Opponent did not reconnect' }));
            if (room.away) room.away.send(JSON.stringify({ type: 'ERROR', msg: 'Opponent did not reconnect' }));
            destroyRoom(room);
        }, 120_000);
    });
});

// ── Action handler ────────────────────────────────────────────────

function handleAction(room, msg) {
    const G = room.G;
    switch (msg.type) {
        case 'ACTIVATE':      room.lastLogMsg = GL.activatePlayer(G, msg.playerId);     break;
        case 'MOVE':          room.lastLogMsg = GL.movePlayer(G, msg.col, msg.row);     break;
        case 'CANCEL':        room.lastLogMsg = GL.cancelActivation(G);                 break;
        case 'STOP':          room.lastLogMsg = GL.endActivation(G);                    break;
        case 'END_TURN':      room.lastLogMsg = GL.endTurn(G);                          break;
        case 'STAND_UP':      room.lastLogMsg = GL.standUp(G, msg.playerId);            break;
        case 'SECURE_BALL':   room.lastLogMsg = GL.secureBall(G, msg.playerId);        break;
        case 'BLITZ_DECLARE': room.lastLogMsg = GL.activateBlitz(G, msg.playerId);      break;
        case 'BLITZ_TARGET':  room.lastLogMsg = GL.setBlitzTarget(G, msg.defId);        break;
        case 'BLITZ_START': {
            const att = G.players.find(p => p.id === msg.attId);
            const def = G.players.find(p => p.id === msg.defId);
            if (att && def) room.lastLogMsg = GL.blitzBlock(G, att, def);
            break;
        }
        case 'BLOCK_START': {
            const att = G.players.find(p => p.id === msg.attId);
            const def = G.players.find(p => p.id === msg.defId);
            if (att && def) room.lastLogMsg = GL.declareBlock(G, att, def);
            break;
        }
        case 'BLOCK_FACE': {
            if (G.block && G.block.phase === 'pick-face') {
                const face = G.block.rolls[msg.faceIdx];
                if (face) room.lastLogMsg = GL.pickBlockFace(G, face);
            }
            break;
        }
        case 'BLOCK_PUSH': {
            if (G.block && G.block.phase === 'pick-push')
                room.lastLogMsg = GL.pickPushSquare(G, msg.col, msg.row);
            break;
        }
        case 'FOLLOW_UP': {
            room.lastLogMsg = GL.resolveFollowUp(G, msg.choice);
            break;
        }
    }
}

// ── Start listening ───────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

// server.js
// Two jobs:
//   1. Serve static files (html, js, css) to the browser
//   2. Handle WebSocket connections between the two players

'use strict';

const http = require('http');   // built into Node.js — no install needed
const fs   = require('fs');     // file system — also built in
const path = require('path');   // file path utilities — also built in
const { WebSocketServer } = require('ws');  // the one library we installed

// ── File server ──────────────────────────────────────────────────
// When a browser asks for a file, find it and send it back.

const MIME_TYPES = {
    '.html': 'text/html',
    '.js':   'text/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.gif':  'image/gif',
    '.png':  'image/png',
};

const httpServer = http.createServer((req, res) => {
    // req.url is what the browser asked for, e.g. '/index.html' or '/logic.js'
    // Default to index.html if they just asked for '/'
    const filePath = req.url === '/' ? '/index.html' : req.url;
    const fullPath = path.join(__dirname, filePath);
    const ext      = path.extname(filePath);
    const mimeType = MIME_TYPES[ext] || 'text/plain';

    fs.readFile(fullPath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': mimeType });
        res.end(data);
    });
});

// ── Game state ───────────────────────────────────────────────────
// The server has its own copy of G — the single source of truth.
// We load logic.js so we can call the same game functions.
// 'require' is Node's way of loading another JS file.

const GL   = require('./logic.js');
const TM   = require('./teams.js');

// Mirror of constants.js — server needs ruleset config too
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
const RULESET = RULESETS.sevens;
global.COLS = RULESET.COLS;
global.ROWS = RULESET.ROWS;
const fs2  = require('fs');
const path2 = require('path');

// Load team definitions from JSON files
function loadTeamDef(filename) {
    const raw = fs2.readFileSync(path2.join(__dirname, filename), 'utf8');
    return JSON.parse(raw);
}

const DEFAULT_HOME = loadTeamDef('team-humans.json');
const DEFAULT_AWAY = loadTeamDef('team-orcs.json');

let G = GL.createInitialState();

// ── Room ─────────────────────────────────────────────────────────
// A room holds the two connected players.
// 'null' means that slot is not yet filled.

const room = {
    home: null,   // WebSocket connection for home player
    away: null,   // WebSocket connection for away player
};

function broadcast(msg) {
    // Send the same message to both players
    const text = JSON.stringify(msg);
    if (room.home) room.home.send(text);
    if (room.away) room.away.send(text);
}

function sideOf(ws) {
    // Which side is this WebSocket connection?
    if (ws === room.home) return 'home';
    if (ws === room.away) return 'away';
    return null;
}

// ── WebSocket server ─────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
    // A new browser has connected.
    // Assign them to the first empty slot.

    if (!room.home) {
        room.home = ws;
        ws.send(JSON.stringify({ type: 'WELCOME', side: 'home' }));
        console.log('Player 1 (home) connected');
    } else if (!room.away) {
        room.away = ws;
        ws.send(JSON.stringify({ type: 'WELCOME', side: 'away' }));
        console.log('Player 2 (away) connected');

        // Both players are here — start the game
        startGame();
    } else {
        // Room is full
        ws.send(JSON.stringify({ type: 'ERROR', msg: 'Room is full' }));
        ws.close();
    }

    // ── Handle incoming messages from this player ──
    ws.on('message', (raw) => {
        const msg  = JSON.parse(raw);
        const side = sideOf(ws);

        console.log(`${side} sent:`, msg.type);

        // Ignore messages from the wrong team
        // Block face pick can come from the defender (when they're stronger)
        // Push choice always comes from attacker
        const turnFree = ['BLOCK_FACE', 'BLOCK_PUSH', 'FOLLOW_UP'].includes(msg.type);
        if (!turnFree && side !== G.active) {
            ws.send(JSON.stringify({ type: 'ERROR', msg: 'Not your turn' }));
            return;
        }

        // Handle the action
        handleAction(msg);

        // Send updated G and the log message to both players
        broadcast({ type: 'UPDATE', G, logMsg: lastLogMsg });
        lastLogMsg = null;
    });

    ws.on('close', () => {
        console.log(`${sideOf(ws)} disconnected`);
        if (ws === room.home) room.home = null;
        if (ws === room.away) room.away = null;
    });
});

// ── Game actions ─────────────────────────────────────────────────
// Mirror of what input.js does in the browser, but runs on the server.

function startGame() {
    G = GL.createInitialState();

    // Initialise formations for active ruleset
    GL.initFormations('sevens');

    // Build rosters from team definitions
    const homePlayers = TM.buildRosterFromTeam(DEFAULT_HOME, 'home', 0,   GL.FORMATION_HOME);
    const awayPlayers = TM.buildRosterFromTeam(DEFAULT_AWAY, 'away', 100, GL.FORMATION_AWAY);
    G.players = [...homePlayers, ...awayPlayers];
    G.players[1].hasBall = true;
    G.ball.carrier = G.players[1];

    console.log('Game started —', G.players.length, 'players');

    // Send START with team defs so clients can load sprites
    broadcast({
        type:     'START',
        G,
        homeTeam: DEFAULT_HOME,
        awayTeam: DEFAULT_AWAY,
        ruleset:  'sevens',
    });
}



let lastLogMsg = null;

// Mirror the onClick handlers in input.js, but run on the server.
// uses const GL = require('./logic.js') loaded above
function handleAction(msg) {
    switch (msg.type) {
        case 'ACTIVATE':        lastLogMsg = GL.activatePlayer(G, msg.playerId);       break;
        case 'MOVE':            lastLogMsg = GL.movePlayer(G, msg.col, msg.row);       break;
        case 'CANCEL':          lastLogMsg = GL.cancelActivation(G);                   break;
        case 'STOP':            lastLogMsg = GL.endActivation(G);                      break;
        case 'END_TURN':        lastLogMsg = GL.endTurn(G);                            break;
        case 'BLITZ_DECLARE':   lastLogMsg = GL.activateBlitz(G, msg.playerId);       break;
        case 'BLITZ_TARGET':    lastLogMsg = GL.setBlitzTarget(G, msg.defId);        break;
        case 'BLITZ_START': {
            const att = G.players.find(p => p.id === msg.attId);
            const def = G.players.find(p => p.id === msg.defId);
            if (att && def) lastLogMsg = GL.blitzBlock(G, att, def);
            break;
        }
        case 'BLOCK_START': {
            const att = G.players.find(p => p.id === msg.attId);
            const def = G.players.find(p => p.id === msg.defId);
            if (att && def) lastLogMsg = GL.declareBlock(G, att, def);
            break;
        }
        case 'BLOCK_FACE': {
            if (G.block && G.block.phase === 'pick-face') {
                const face = G.block.rolls[msg.faceIdx];
                if (face) lastLogMsg = GL.pickBlockFace(G, face);
            }
            break;
        }
        case 'BLOCK_PUSH': {
            if (G.block && G.block.phase === 'pick-push')
                lastLogMsg = GL.pickPushSquare(G, msg.col, msg.row);
            break;
        }
        case 'FOLLOW_UP': {
            lastLogMsg = GL.resolveFollowUp(G, msg.choice);
            break;
        }
    }
}

// ── Start listening ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log('Open two browser tabs to play');
});

// network.js
// WebSocket transport layer — connect, send, receive, route to game.
// Knows nothing about game logic or rendering beyond calling into game.js.

var NET = {
    online: false,
    side:   null,
    roomId: null,
    ws:     null,
};

// ── connect ───────────────────────────────────────────────────────
// Opens a WebSocket connection to the server.
// Does NOT create or join a room — call createRoom() or joinRoom() after.

function connect() {
    return new Promise((resolve, reject) => {
        const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
        NET.ws = new WebSocket(`${protocol}://${location.host}`);

        NET.ws.onopen    = () => resolve();
        NET.ws.onmessage = (event) => netReceive(JSON.parse(event.data));
        NET.ws.onclose   = () => {
            console.log('Disconnected');
            NET.online = false;
        };
        NET.ws.onerror = (err) => {
            console.error('WebSocket error:', err);
            reject(err);
        };
    });
}

// ── createRoom / joinRoom ─────────────────────────────────────────

function createRoom() {
    sendAction({ type: 'CREATE_ROOM' });
}

function joinRoom(roomId) {
    sendAction({ type: 'JOIN_ROOM', roomId });
}

// ── sendAction ────────────────────────────────────────────────────

function sendAction(msg) {
    if (!NET.ws || NET.ws.readyState !== WebSocket.OPEN) return;
    NET.ws.send(JSON.stringify(msg));
}

// ── netReceive ────────────────────────────────────────────────────

function netReceive(msg) {
    console.log('Received:', msg.type);

    switch (msg.type) {

        case 'LOBBY_UPDATE':
            onLobbyUpdate(msg.rooms);
            break;

        case 'ROOM_CREATED':
            NET.side   = msg.side;
            NET.online = true;
            onRoomReady(msg.side);  // home waits for opponent
            break;

        case 'ROOM_JOINED':
            NET.side   = msg.side;
            NET.online = true;
            // away player goes straight to game when START arrives — no waiting screen
            break;

        case 'START':
            // game.js handles ruleset, formations, pitch setup, and rendering
            startGame(msg.homeTeam, msg.awayTeam, msg.ruleset);
            // fall through to apply the initial G

        case 'UPDATE':
            if (msg.logMsg) log(msg.logMsg);
            Object.assign(G, msg.G);
            fixReferences(G);
            render();
            break;

        case 'ERROR':
            console.warn('Server says:', msg.msg);
            break;
    }
}

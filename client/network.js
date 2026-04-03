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

        NET.ws.onopen    = () => {
            resolve();
            const saved = _loadReconnectToken();
            if (saved) sendAction({ type: 'RECONNECT', roomId: saved.roomId, side: saved.side, token: saved.token });
        };
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

// ── reconnect token helpers ───────────────────────────────────────

function _loadReconnectToken() {
    try {
        const raw = localStorage.getItem('bbReconnect');
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function _clearReconnectToken() {
    localStorage.removeItem('bbReconnect');
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
            NET.roomId = msg.roomId;
            NET.online = true;
            localStorage.setItem('bbReconnect', JSON.stringify({ roomId: msg.roomId, side: msg.side, token: msg.token }));
            onRoomReady(msg.side);  // home waits for opponent
            break;

        case 'ROOM_JOINED':
            NET.side   = msg.side;
            NET.roomId = msg.roomId;
            NET.online = true;
            localStorage.setItem('bbReconnect', JSON.stringify({ roomId: msg.roomId, side: msg.side, token: msg.token }));
            // away player goes straight to game when START arrives — no waiting screen
            break;

        case 'START':
            startGame(msg.homeTeam, msg.awayTeam);
            // fall through to apply the initial G

        case 'UPDATE': {
            document.getElementById('reconnect-overlay').classList.add('hidden');
            if (msg.logMsg) log(msg.logMsg);
            const prevSetupSide = G.setupSide;
            Object.assign(G, msg.G);
            fixReferences(G);
            if (G.phase !== 'setup') {
                setupErrors = null;
            } else if (msg.setupError && msg.logMsg) {
                setupErrors = [msg.logMsg];
            }
            if (G.phase === 'setup' && G.setupSide !== prevSetupSide) scrollToSetupSide();
            render();
            if (G.phase === 'toss') {
                showTossOverlay(G.tossWinner, NET.side === G.tossWinner);
            } else {
                document.getElementById('toss-overlay').style.display = 'none';
            }
            break;
        }

        case 'OPPONENT_DISCONNECTED':
            document.getElementById('reconnect-overlay').classList.remove('hidden');
            break;

        case 'RECONNECTED': {
            const saved = _loadReconnectToken();
            NET.side   = saved.side;
            NET.roomId = saved.roomId;
            NET.online = true;
            startGame(msg.homeTeam, msg.awayTeam);
            Object.assign(G, msg.G);
            fixReferences(G);
            render();
            document.getElementById('reconnect-overlay').classList.add('hidden');
            break;
        }

        case 'OPPONENT_RECONNECTED':
            Object.assign(G, msg.G);
            fixReferences(G);
            document.getElementById('reconnect-overlay').classList.add('hidden');
            render();
            break;

        case 'RECONNECT_FAILED':
            _clearReconnectToken();
            console.warn('Reconnect failed:', msg.msg);
            break;

        case 'ERROR':
            console.warn('Server says:', msg.msg);
            break;
    }
}

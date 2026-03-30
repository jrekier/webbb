// network.js
// Manages the WebSocket connection to the server.

var NET = {
    online: false,
    side:   null,
    ws:     null,
};

function connect() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    NET.ws = new WebSocket(`${protocol}://${location.host}`);

    NET.ws.onopen    = () => console.log('Connected to server');
    NET.ws.onmessage = (event) => netReceive(JSON.parse(event.data));
    NET.ws.onclose   = () => {
        console.log('Disconnected');
        NET.online = false;
    };
    NET.ws.onerror = (err) => console.error('WebSocket error:', err);
}

function netReceive(msg) {
    console.log('Received:', msg.type);

    switch (msg.type) {

        case 'WELCOME':
            NET.side   = msg.side;
            NET.online = true;
            // Update status label — show which side we are
            const netEl = document.getElementById('net-status');
            netEl.textContent = `You are ${NET.side.toUpperCase()}`;
            netEl.className   = 'connected';
            // Hide the connect button — no longer needed
            document.getElementById('btn-connect').style.display = 'none';
            break;

        case 'START':
            document.getElementById('online-strip').classList.add('hidden');
            log('Game started online', 'turn-marker');

            // Apply ruleset from server
            if (msg.ruleset && RULESETS[msg.ruleset]) {
                RULESET = RULESETS[msg.ruleset];
                COLS    = RULESET.COLS;
                ROWS    = RULESET.ROWS;
                TURNS   = RULESET.TURNS;
                initFormations();
                sizePitch();  // resize canvas for new dimensions
            }

            if (msg.homeTeam)
                document.getElementById('lbl-home-team').textContent =
                    msg.homeTeam.name.toUpperCase();
            if (msg.awayTeam)
                document.getElementById('lbl-away-team').textContent =
                    msg.awayTeam.name.toUpperCase();

            loadSpriteSheet();

            // fall through to UPDATE

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

function sendAction(msg) {
    if (!NET.ws || NET.ws.readyState !== WebSocket.OPEN) return;
    NET.ws.send(JSON.stringify(msg));
}

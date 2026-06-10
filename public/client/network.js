// network.js
// WebSocket transport layer — connect, send, receive, route to game.
// Knows nothing about game logic or rendering beyond calling into game.js.

var NET = {
    online: false,
    side:   null,
    roomId: null,
    ws:     null,
};

// When we're embedded in the bbauth wrapper (an iframe), tell the parent when
// the match ends so a refresh of the wrapper page won't try to resume a
// finished game. No-op when running standalone.
function _notifyParent(type) {
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ source: 'webbb', type }, '*'); }
    catch {}
}

// ── Auto-reconnect ────────────────────────────────────────────────
// When the WebSocket drops mid-game we keep retrying (with exponential
// backoff + jitter, capped) for as long as a saved session exists. The
// server holds the room open for 2 minutes, so a brief blip recovers in
// well under a second and longer outages keep trying without hammering.

var _reconnectTimer   = null;
var _reconnectAttempt = 0;
var _overlayTimer     = null;   // delays both reconnect overlays so brief blips stay invisible

// A disconnect must persist this long before we surface an overlay. Most blips
// (wifi hiccup, mobile handoff, proxy hiccup) recover well under this, so they
// flash nothing. This is display-only: it changes nothing about game state,
// input handling, or when the server learns of the drop.
var RECONNECT_OVERLAY_GRACE_MS = 2000;

// Arm a reconnect overlay to appear only if we're still in trouble after the
// grace window. A recovery (own reconnect, or opponent back) cancels it first,
// so a quick blip never shows anything. self=true → "Reconnecting…",
// self=false → "Opponent disconnected".
function _armOverlay(self) {
    if (_overlayTimer) return;   // already pending — don't restart the clock
    _overlayTimer = setTimeout(() => { _overlayTimer = null; _showReconnecting(self); }, RECONNECT_OVERLAY_GRACE_MS);
}

function _cancelOverlay() {
    if (_overlayTimer) { clearTimeout(_overlayTimer); _overlayTimer = null; }
}

function _scheduleReconnect() {
    if (_reconnectTimer) return;
    const saved = loadReconnectToken();
    if (!saved) return;          // no live session — nothing to reconnect to

    _armOverlay(true);           // surface "Reconnecting…" only if the blip outlasts the grace

    // 1st retry ~0.3s (covers a quick blip), then 0.6, 1.2, 2.4, … capped at 8s.
    const base  = Math.min(8000, 300 * Math.pow(2, _reconnectAttempt));
    const delay = base + Math.floor(Math.random() * 300);   // jitter
    _reconnectAttempt++;
    _reconnectTimer = setTimeout(() => {
        _reconnectTimer = null;
        connect().catch(() => _scheduleReconnect());
    }, delay);
}

// Connection is healthy again — stop the backoff and clear the overlay.
function _reconnectSucceeded() {
    _reconnectAttempt = 0;
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    _cancelOverlay();
    _hideReconnecting();
}

// ── Reconnect overlay ─────────────────────────────────────────────
// Shown to the local player while their own connection is recovering
// (self=true), or while waiting on a disconnected opponent (self=false).

function _showReconnecting(self) {
    const overlay = document.getElementById('reconnect-overlay');
    if (!overlay) return;
    const msg = document.getElementById('reconnect-msg');
    const sub = document.getElementById('reconnect-sub');
    if (msg) msg.textContent = self ? 'Connection lost' : 'Opponent disconnected';
    if (sub) sub.textContent = self ? 'Reconnecting…'    : 'Waiting for them to reconnect…';
    overlay.classList.remove('hidden');
}

function _hideReconnecting() {
    const overlay = document.getElementById('reconnect-overlay');
    if (overlay) overlay.classList.add('hidden');
}

// ── connect ───────────────────────────────────────────────────────
// Opens a WebSocket connection to the server. On open it auto-resumes a saved
// session (RECONNECT); the bbauth entry flow (welcome.js) sends ATTACH with its
// token after connecting, claiming its slot in a pre-registered room.

function connect() {
    return new Promise((resolve, reject) => {
        const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
        NET.ws = new WebSocket(`${protocol}://${location.host}`);

        NET.ws.onopen    = () => {
            resolve();
            const saved = loadReconnectToken();
            if (saved) sendAction({ type: 'RECONNECT', roomId: saved.roomId, side: saved.side, token: saved.token });
        };
        NET.ws.onmessage = (event) => netReceive(JSON.parse(event.data));
        NET.ws.onclose   = () => {
            console.log('Disconnected');
            NET.online = false;
            _scheduleReconnect();
        };
        NET.ws.onerror = (err) => {
            console.error('WebSocket error:', err);
            reject(err);
        };
    });
}

// ── reconnect token helpers ───────────────────────────────────────

function loadReconnectToken() {
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

        case 'ATTACHED':
            // We've claimed our pre-registered slot. The opponent may or may not
            // have attached yet, so wait until START arrives (it follows once both
            // sides are present). Whoever attaches first sees the waiting screen briefly.
            NET.side   = msg.side;
            NET.roomId = msg.roomId;
            NET.online = true;
            localStorage.setItem('bbReconnect', JSON.stringify({ roomId: msg.roomId, side: msg.side, token: msg.token }));
            onRoomReady(msg.side);
            break;

        case 'START':
            startGame(msg.homeTeam, msg.awayTeam);
            // fall through to apply the initial G

        case 'UPDATE': {
            _reconnectSucceeded();   // healthy traffic — clear overlay, reset backoff
            if (msg.logMsg) log(msg.logMsg);
            // Server-authored turn-start marker (online): logged here, after the
            // action line, in the same order it's stored in the room history.
            if (msg.turnMarker) log(msg.turnMarker.msg, msg.turnMarker.type);
            const prevActive    = G.active;
            const prevPhase     = G.phase;
            const prevSetupSide = G.setupSide;
            const testMode      = G.testMode;
            Object.assign(G, msg.G);
            G.testMode = testMode;
            fixReferences(G);
            if (G.phase !== 'setup') {
                setupErrors = null;
            } else if (msg.setupError && msg.logMsg) {
                setupErrors = [msg.logMsg];
            }
            if (G.phase === 'setup' && G.setupSide !== prevSetupSide) scrollToSetupSide();
            if (G.phase === 'play' && G.active !== prevActive && G.active === NET.side) {
                showTurnToast(NET.side);
            }
            render();
            if (G.phase === 'toss') {
                showTossOverlay(G.tossWinner, NET.side === G.tossWinner);
            } else {
                document.getElementById('toss-overlay').style.display = 'none';
            }
            if (G.phase === 'gameover' && prevPhase !== 'gameover') _notifyParent('gameover');
            break;
        }

        case 'OPPONENT_DISCONNECTED':
            _armOverlay(false);   // grace it — a brief opponent blip won't flash
            break;

        case 'RECONNECTED': {
            const saved = loadReconnectToken();
            NET.side   = saved.side;
            NET.roomId = saved.roomId;
            NET.online = true;
            // Cold start (page reloaded): game UI not yet built.
            // Warm reconnect (WS dropped but page still running): skip
            // startGame to avoid re-registering duplicate event listeners.
            if (!homeTeamDef) {
                startGame(msg.homeTeam, msg.awayTeam);
            }
            Object.assign(G, msg.G);
            fixReferences(G);
            // Rebuild the play-by-play from the server's history (the log is
            // otherwise client-side only and would come back empty). Clear first
            // so a warm reconnect doesn't duplicate lines already on screen.
            if (Array.isArray(msg.log)) {
                const logEl = document.getElementById('log');
                if (logEl) logEl.innerHTML = '';
                msg.log.forEach(e => {
                    // Entries are { msg, type? }; tolerate plain strings from
                    // older snapshots.
                    if (typeof e === 'string') log(e);
                    else log(e.msg, e.type);
                });
            }
            render();
            _reconnectSucceeded();
            break;
        }

        case 'OPPONENT_RECONNECTED':
            Object.assign(G, msg.G);
            fixReferences(G);
            _cancelOverlay();   // opponent came back within (or after) the grace — never/no longer flash
            _hideReconnecting();
            render();
            break;

        case 'RECONNECT_FAILED':
            _clearReconnectToken();
            _reconnectAttempt = 0;
            if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
            _cancelOverlay();
            console.warn('Reconnect failed:', msg.msg);
            // Mid-game the grace may mean the "Reconnecting…" overlay hasn't
            // appeared yet — surface it so the terminal message is visible. On a
            // cold load (e.g. the bbauth wrapper re-embedded us, or a stale token)
            // there's no game to show, so tell the wrapper the session is over and
            // fall back to the welcome screen instead of hanging.
            if (typeof homeTeamDef !== 'undefined' && homeTeamDef) {
                _showReconnecting(true);
                _endOverlay('Could not reconnect', 'The session has ended.');
            } else {
                _notifyParent('ended');
                showScreen('welcome');
            }
            break;

        case 'ERROR':
            console.warn('Server says:', msg.msg);
            _cancelOverlay();
            // If we were waiting on a (dis)connected player and the server gives
            // up (e.g. grace period expired), turn the overlay into an end state.
            _endOverlay('Game ended', msg.msg);
            break;
    }
}

// If the reconnect overlay is currently visible, convert it to a terminal
// message (no-op when hidden, so it never fires on the welcome screen).
function _endOverlay(title, sub) {
    const overlay = document.getElementById('reconnect-overlay');
    if (!overlay || overlay.classList.contains('hidden')) return;
    const msg = document.getElementById('reconnect-msg');
    const s   = document.getElementById('reconnect-sub');
    if (msg) msg.textContent = title;
    if (s)   s.textContent   = sub || 'The session has ended.';
    _notifyParent('ended');   // wrapper can drop its resume marker — this game is over
}

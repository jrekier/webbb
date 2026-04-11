// welcome.js
// App entry point and screen manager.
// Owns: showScreen(), the welcome screen, and the local game startup flow.

// ── Screen manager ────────────────────────────────────────────────
// Screens are <div id="screen-*"> elements in index.html.
// Only one is visible at a time.

function showScreen(name) {
    document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
    const el = document.getElementById('screen-' + name);
    if (el) el.classList.remove('hidden');
}

// ── Auth token ────────────────────────────────────────────────────
// If bbauth redirected here with ?token=..., decode the payload and
// store the user's team. The raw token is also kept for online play.

(function () {
    const params = new URLSearchParams(location.search);
    const raw    = params.get('token');
    if (!raw) return;
    try {
        const payload = JSON.parse(atob(raw.split('.')[0]));
        if (payload.teamDef) {
            window._authTeamDef = payload.teamDef;
            window._authToken   = raw;
            window._authRoomId  = params.get('roomId') || null;
            window._authAction  = params.get('action') || null;  // 'create' | 'join'
        }
    } catch (e) {
        console.warn('Could not parse auth token:', e);
    }
})();

// ── App entry point ───────────────────────────────────────────────

function startApp(homeTeam, awayTeam) {
    // Stash default teams for local play
    window._defaultHomeTeam = homeTeam;
    window._defaultAwayTeam = awayTeam;

    if (typeof createBanner === 'function') {
        const el     = document.getElementById('welcome-banner');
        const canvas = createBanner({ title: 'Blood Bowl' });
        el.appendChild(canvas);
        window.addEventListener('resize', () => drawBanner(canvas, { title: 'Blood Bowl' }));
    }

    // If redirected from bbauth with an action, skip the welcome screen and go straight in.
    // Clear any stale reconnect token first — it must not race with the new CREATE/JOIN.
    if (window._authAction === 'create' || window._authAction === 'join') {
        _clearReconnectToken();
        connect()
            .then(() => {
                if (window._authAction === 'create') {
                    sendAction({ type: 'CREATE_ROOM', authToken: window._authToken, roomId: window._authRoomId });
                } else {
                    sendAction({ type: 'JOIN_ROOM', roomId: window._authRoomId, authToken: window._authToken });
                }
            })
            .catch(() => showScreen('welcome'));
        return;
    }

    showScreen('welcome');

    // Attempt silent reconnect in background if a saved session exists
    const saved = loadReconnectToken();
    if (saved) connect().catch(() => {});
}

// ── Local game ────────────────────────────────────────────────────

function onClickLocalGame() {
    const home = window._authTeamDef || window._defaultHomeTeam;
    startGame(home, window._defaultAwayTeam);
}

// ── Online game ───────────────────────────────────────────────────

function onClickOnline() {
    connect().then(() => enterLobby());
}

function onClickCreateRoom() {
    sendAction({ type: 'CREATE_ROOM' });
}

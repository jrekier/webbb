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
        }
    } catch (e) {
        console.warn('Could not parse auth token:', e);
    }
})();

// ── App entry point ───────────────────────────────────────────────
// allTeams: { humans, orcs, skaven } — team definitions loaded from JSON

var _allTeams = {};

var _TEAM_LOGOS = {
    humans: 'assets/logos/Human_BB2025.svg',
    orcs:   'assets/logos/Orc_BB2025.svg',
    skaven: 'assets/logos/Skaven_BB2025.svg',
    dwarfs: 'assets/logos/Dwarf_BB2025.svg',
    imperialnobility: 'assets/logos/ImperialNobility_BB2025.svg',
};

function _initTeamLogos() {
    document.querySelectorAll('#screen-team-select .team-choice-btn').forEach(btn => {
        const src = _TEAM_LOGOS[btn.dataset.race];
        const img = btn.querySelector('.tcb-logo');
        if (img && src) img.src = resolveSheet(src);
    });
}

function startApp(allTeams) {
    _allTeams = allTeams;
    _initTeamLogos();

    // Spectate mode: opened by the bbauth lobby as ?spectate=ROOMID. Connect and
    // ask to watch — no token, no team, read-only (see the SPECTATING handler).
    const spectateRoom = new URLSearchParams(location.search).get('spectate');
    if (spectateRoom) {
        NET.spectator = true;
        showScreen('reconnecting');   // neutral hold screen until the snapshot arrives
        connect()
            .then(() => sendAction({ type: 'SPECTATE', roomId: spectateRoom }))
            .catch(() => showScreen('welcome'));
        return;
    }

    // If redirected from bbauth with a pre-registered room, skip the welcome
    // screen and attach to our slot. The token identifies which side we are, so
    // there is no create/join distinction — the room already exists server-side.
    // Clear any stale reconnect token first — it must not race with the new ATTACH.
    if (window._authRoomId && window._authToken) {
        // Consume the one-time auth params from the URL. Otherwise a page reload
        // would re-run ATTACH instead of silently reconnecting. The values are
        // already captured in window._auth* above.
        history.replaceState(null, '', location.pathname);
        _clearReconnectToken();
        connect()
            .then(() => sendAction({ type: 'ATTACH', roomId: window._authRoomId, authToken: window._authToken }))
            .catch(() => showScreen('welcome'));
        return;
    }

    // Auto-resume a live game only when we're embedded in the bbauth wrapper
    // (the iframe-reload resume path). Loaded top-level/standalone — e.g. opening
    // http://localhost:3000 directly during dev — show the welcome screen instead
    // of trapping the user in a leftover game they can't leave. A live socket that
    // drops mid-game still reconnects on its own (see network.js onclose).
    const saved    = loadReconnectToken();
    const embedded = window.parent !== window;
    if (saved && embedded) {
        // Show a hold state while rejoining rather than flashing the welcome menu.
        // RECONNECTED swaps us into the game; a failed reconnect (room gone) falls
        // back to welcome via the RECONNECT_FAILED handler / connect rejection.
        showScreen('reconnecting');
        connect().catch(() => showScreen('welcome'));
    } else {
        showScreen('welcome');
    }
}

// ── Local game — team selection ───────────────────────────────────

var _selectedHomeKey = 'humans';
var _selectedAwayKey = 'orcs';

function onClickLocalGame() {
    showScreen('team-select');
}

function selectTeam(side, key) {
    if (side === 'home') _selectedHomeKey = key;
    else                 _selectedAwayKey = key;

    const groupId = side === 'home' ? 'tcg-home' : 'tcg-away';
    const group   = document.getElementById(groupId);
    if (!group) return;

    group.querySelectorAll('.team-choice-btn').forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.race === key);
    });
}

function onClickStartLocalGame() {
    const home = window._authTeamDef || _allTeams[_selectedHomeKey];
    const away = _allTeams[_selectedAwayKey];
    startGame(home, away);
}

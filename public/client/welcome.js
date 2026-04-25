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
// allTeams: { humans, orcs, skaven } — team definitions loaded from JSON

var _allTeams = {};

var _TEAM_LOGOS = {
    humans: 'assets/logos/Human_BB2025.svg',
    orcs:   'assets/logos/Orc_BB2025.svg',
    skaven: 'assets/logos/Skaven_BB2025.svg',
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

// ── Online game ───────────────────────────────────────────────────

function onClickOnline() {
    connect().then(() => enterLobby());
}

function onClickCreateRoom() {
    sendAction({ type: 'CREATE_ROOM' });
}

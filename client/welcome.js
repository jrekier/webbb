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

// ── App entry point ───────────────────────────────────────────────

function startApp(homeTeam, awayTeam) {
    // Stash default teams for local play
    window._defaultHomeTeam = homeTeam;
    window._defaultAwayTeam = awayTeam;

    showScreen('welcome');

    // Attempt silent reconnect in background if a saved session exists
    const saved = _loadReconnectToken();
    if (saved) connect().catch(() => {});
}

// ── Local game ────────────────────────────────────────────────────

function onClickLocalGame() {
    startGame(window._defaultHomeTeam, window._defaultAwayTeam);
}

// ── Online game ───────────────────────────────────────────────────

function onClickOnline() {
    connect().then(() => enterLobby());
}

function onClickCreateRoom() {
    sendAction({ type: 'CREATE_ROOM' });
}

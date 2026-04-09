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

async function startApp(homeTeam, awayTeam) {
    // Stash default teams for local play
    window._defaultHomeTeam = homeTeam;
    window._defaultAwayTeam = awayTeam;

    // Check for existing auth session first
    const user = await checkAuth();
    if (user) {
        document.getElementById('welcome-username').textContent = user.username;
        // Populate active team label if a team is selected
        const activeId = getActiveTeamId();
        if (activeId) {
            fetch('/api/teams', { headers: { 'Authorization': 'Bearer ' + getAuthToken() } })
                .then(r => r.json())
                .then(data => {
                    const team = data.teams && data.teams.find(t => t.id === activeId);
                    document.getElementById('welcome-active-team').textContent =
                        team ? team.name + ' (' + team.race + ')' : 'Default roster';
                })
                .catch(() => {});
        }
        showScreen('welcome');
        // Attempt silent reconnect in background if a saved game session exists
        const saved = loadReconnectToken();
        if (saved) connect().catch(() => {});
    } else {
        showScreen('auth');
    }
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
    createRoom();  // defined in network.js — attaches active teamId automatically
}

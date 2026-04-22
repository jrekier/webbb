// game.js
// Game screen initialisation — shared by both local and online paths.
// Does not care how the game was started; just sets up the board and renders.

var homeTeamDef = null;
var awayTeamDef = null;

// ── startGame ─────────────────────────────────────────────────────
// Entry point for both local and online play.
// homeTeam / awayTeam: validated team definition objects.
// ruleset: 'sevens' | 'classic'

function startGame(homeTeam, awayTeam) {
    homeTeamDef = loadTeamFromJSON(homeTeam);
    awayTeamDef = loadTeamFromJSON(awayTeam);

    showScreen('game');
    initFormations();
    buildPitch();
    setupInput();
    prewarmSprites(homeTeamDef);
    prewarmSprites(awayTeamDef);
    loadSpriteSheet();

    if (!NET.online) {
        // Local: build the initial state here. Online: server sends it via UPDATE.
        const homePlayers = buildRosterFromTeam(homeTeamDef, 'home', 0,   FORMATION_HOME);
        const awayPlayers = buildRosterFromTeam(awayTeamDef, 'away', 100, FORMATION_AWAY);
        G.players = [...homePlayers, ...awayPlayers];
        const winner = initToss(G);
        showTossOverlay(winner);
        render();
    }

    document.getElementById('lbl-home-team').textContent = homeTeamDef.name.toUpperCase();
    document.getElementById('lbl-away-team').textContent = awayTeamDef.name.toUpperCase();

    // Propagate resolved team colours to the CSS variables used throughout the UI.
    const root = document.documentElement;
    if (homeTeamDef.colour) {
        const [r, g, b] = homeTeamDef.colour;
        root.style.setProperty('--home', `rgb(${r},${g},${b})`);
    }
    if (awayTeamDef.colour) {
        const [r, g, b] = awayTeamDef.colour;
        root.style.setProperty('--away', `rgb(${r},${g},${b})`);
    }
}

// ── Your-turn toast ──────────────────────────────────────────────

var _toastTimer = null;

function showTurnToast(side) {
    const el = document.getElementById('turn-toast');
    if (!el) return;
    if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
    el.textContent = 'YOUR TURN';
    el.classList.remove('toast-in', 'toast-home', 'toast-away');
    void el.offsetWidth;
    el.classList.add(side === 'home' ? 'toast-home' : 'toast-away', 'toast-in');
    _toastTimer = setTimeout(() => {
        el.classList.remove('toast-in');
        _toastTimer = null;
    }, 2500);
}

// ── Toss overlay ─────────────────────────────────────────────────

function showTossOverlay(winner, canChoose = true) {
    const lbl = document.getElementById('toss-winner-label');
    lbl.textContent = `${winner.toUpperCase()} WINS THE TOSS`;
    lbl.className   = winner === 'home' ? 'team-home' : 'team-away';
    document.getElementById('toss-body').style.display     = canChoose ? '' : 'none';
    document.getElementById('toss-overlay').style.display  = 'flex';
}

function onTossChoose(choice) {
    document.getElementById('toss-overlay').style.display = 'none';
    if (NET.online) {
        sendAction({ type: 'TOSS_CHOOSE', choice });
        return;
    }
    const msg = chooseTossResult(G, choice);
    log(msg);
    scrollToSetupSide();
    render();
}

// ── onRoomReady ───────────────────────────────────────────────────
// Called by network.js once the server has assigned us to a room.
// Shows the waiting state until the opponent connects and START arrives.

function onRoomReady(side) {
    showScreen('waiting');
    document.getElementById('lbl-room-side').textContent = side.toUpperCase();
}

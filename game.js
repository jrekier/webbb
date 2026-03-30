// game.js
// Game screen initialisation — shared by both local and online paths.
// Does not care how the game was started; just sets up the board and renders.

var homeTeamDef = null;
var awayTeamDef = null;

// ── startGame ─────────────────────────────────────────────────────
// Entry point for both local and online play.
// homeTeam / awayTeam: validated team definition objects.
// ruleset: 'sevens' | 'classic'

function startGame(homeTeam, awayTeam, ruleset) {
    ruleset = ruleset || 'sevens';

    homeTeamDef = loadTeamFromJSON(homeTeam);
    awayTeamDef = loadTeamFromJSON(awayTeam);

    if (RULESETS[ruleset]) {
        RULESET = RULESETS[ruleset];
        COLS    = RULESET.COLS;
        ROWS    = RULESET.ROWS;
        TURNS   = RULESET.TURNS;
    }

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
        G.players             = [...homePlayers, ...awayPlayers];
        G.players[1].hasBall  = true;
        G.ball.carrier        = G.players[1];
        log('Match begins', 'turn-marker');
        render();
    }

    document.getElementById('lbl-home-team').textContent = homeTeamDef.name.toUpperCase();
    document.getElementById('lbl-away-team').textContent = awayTeamDef.name.toUpperCase();
}

// ── onRoomReady ───────────────────────────────────────────────────
// Called by network.js once the server has assigned us to a room.
// Shows the waiting state until the opponent connects and START arrives.

function onRoomReady(side) {
    showScreen('waiting');
    document.getElementById('lbl-room-side').textContent = side.toUpperCase();
}

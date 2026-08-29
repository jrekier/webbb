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
    // Copy so colour mutation below doesn't affect the shared _allTeams objects.
    homeTeamDef = { ...loadTeamFromJSON(homeTeam) };
    awayTeamDef = { ...loadTeamFromJSON(awayTeam) };

    if (!NET.online) {
        // Local only: server already resolves colours before broadcasting START,
        // so online teams arrive with .colour pre-set — don't touch them here.
        // For local play, pick home colour; fall back to away colour if it clashes.
        const homeCol  = homeTeamDef.homeColour || homeTeamDef.colour || [180, 40, 40];
        const awayPref = awayTeamDef.homeColour || awayTeamDef.colour || [40, 40, 180];
        const awayFb   = awayTeamDef.awayColour || awayPref;
        const clash    = homeCol.every((v, i) => v === awayPref[i]);
        homeTeamDef.colour = homeCol;
        awayTeamDef.colour = clash ? awayFb : awayPref;
    }

    // Seed G with a full initial state so render() is safe during buildPitch.
    Object.assign(G, createInitialState());

    showScreen('game');
    initFormations();
    buildPitch();
    // Spectators are read-only: wire no input, and flag the body so the board
    // can show a "spectating" banner / suppress any interactive affordances.
    if (NET.spectator) {
        document.body.classList.add('spectating');
        const banner = document.getElementById('spectate-banner');
        if (banner) banner.classList.remove('hidden');
    } else {
        setupInput();
    }
    prewarmSprites(homeTeamDef);
    prewarmSprites(awayTeamDef);
    loadSpriteSheet();

    if (!NET.online) {
        // Local: build the initial state here. Online: server sends it via UPDATE.
        const homePlayers = buildRosterFromTeam(homeTeamDef, 'home', 0,   FORMATION_HOME);
        const awayPlayers = buildRosterFromTeam(awayTeamDef, 'away', 100, FORMATION_AWAY);
        G.players        = [...homePlayers, ...awayPlayers];
        G.rerolls         = { home: homeTeamDef.rerolls || 0, away: awayTeamDef.rerolls || 0 };
        G.startingRerolls = { ...G.rerolls };
        G.bribes          = { home: homeTeamDef.bribes  || 0, away: awayTeamDef.bribes  || 0 };
        G.cheerleaders    = { home: homeTeamDef.cheerleaders    || 0, away: awayTeamDef.cheerleaders    || 0 };
        G.assistantCoaches = { home: homeTeamDef.assistantCoaches || 0, away: awayTeamDef.assistantCoaches || 0 };
        G.fanFactor       = { home: homeTeamDef.fanFactor       || 0, away: awayTeamDef.fanFactor       || 0 };
        G.apothecary      = { home: !!homeTeamDef.apothecary,         away: !!awayTeamDef.apothecary         };
        G.teamValue       = { home: homeTeamDef.tv || 0, away: awayTeamDef.tv || 0 };
        G.specialRules    = { home: homeTeamDef.specialRules || [], away: awayTeamDef.specialRules || [] };
        G.inducements     = { home: homeTeamDef.inducements  || {}, away: awayTeamDef.inducements  || {} };
        G.kegs            = { home: homeTeamDef.kegs || 0,    away: awayTeamDef.kegs || 0 };
        G.masterChef      = { home: !!homeTeamDef.masterChef, away: !!awayTeamDef.masterChef };
        G.prayers         = { home: homeTeamDef.prayers || [], away: awayTeamDef.prayers || [] };
        G.desperateMeasures = { home: homeTeamDef.desperateMeasures || [], away: awayTeamDef.desperateMeasures || [] };
        G.treasury        = { home: homeTeamDef.treasury        || 0, away: awayTeamDef.treasury        || 0 };
        const winner = initToss(G);
        showTossOverlay(winner);
        render();
    }

    applyTeamLogo('home', homeTeamDef);
    applyTeamLogo('away', awayTeamDef);

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

// ── applyTeamLogo ────────────────────────────────────────────────
// Sets the race logo (as a CSS mask) and the title (full team name)
// on the status-strip team chip. Falls back to a generic shield silhouette
// when the team has no race field (custom uploaded teams).

function applyTeamLogo(side, teamDef) {
    const logoEl = document.getElementById(`ss-logo-${side}`);
    const chipEl = document.querySelector(`#status-strip .ss-${side}`);
    if (!logoEl || !chipEl) return;

    const race = teamDef.race;
    const url  = (race && _TEAM_LOGOS[race]) ? resolveSheet(_TEAM_LOGOS[race]) : null;
    if (url) {
        const cssUrl = `url("${url}")`;
        logoEl.style.webkitMaskImage = cssUrl;
        logoEl.style.maskImage       = cssUrl;
        logoEl.style.display         = '';
    } else {
        logoEl.style.display = 'none';
    }
    chipEl.setAttribute('title', teamDef.name || side.toUpperCase());
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

// ── Debug mode ────────────────────────────────────────────────────

function toggleDebugMode() {
    G.testMode = !G.testMode;
    const btn = document.getElementById('btn-debug');
    if (btn) btn.classList.toggle('debug-active', !!G.testMode);
    render();
}

// ── Debug: match-scoped inducements ───────────────────────────────
// Prayers, Desperate Measures, Kegs and the Master Chef are normally bought in
// bbauth and rolled at launch, which makes them slow to exercise. In debug mode
// they can be granted straight into G here, so a local hot-seat game can test
// every effect without a staging room, a second browser, or lucky dice.
var _debugSide = 'home';

function debugSetSide(side) { _debugSide = side; render(); }

function _debugPush(side) {
    if (NET.online) sendAction({
        type: 'DEBUG_SET_MATCH', side,
        prayers:           G.prayers[side],
        desperateMeasures: G.desperateMeasures[side],
        desperateUsed:     G.desperateUsed[side],
        kegs:              G.kegs[side],
        masterChef:        G.masterChef[side],
        bribes:            G.bribes[side],
    });
    render();
}

function debugTogglePrayer(side, key) {
    const list = G.prayers[side] || (G.prayers[side] = []);
    const i = list.indexOf(key);
    if (i >= 0) list.splice(i, 1); else list.push(key);
    _debugPush(side);
}

function debugToggleDesperate(side, key) {
    const list = G.desperateMeasures[side] || (G.desperateMeasures[side] = []);
    const i = list.indexOf(key);
    if (i >= 0) {
        list.splice(i, 1);
    } else {
        list.push(key);
    }
    // Granting always hands back a fresh, unspent one.
    if (G.desperateUsed?.[side]) delete G.desperateUsed[side][key];
    _debugPush(side);
}

function debugBump(side, field, delta, max) {
    const cur = G[field][side] || 0;
    G[field][side] = Math.max(0, Math.min(max, cur + delta));
    _debugPush(side);
}

function debugToggleFlag(side, field) {
    G[field][side] = !G[field][side];
    _debugPush(side);
}

function addSkillToSelected() {
    const p = G.sel;
    if (!p) return;
    const sel   = document.getElementById('skill-select');
    const skill = sel.value;
    if (!skill) return;
    if (!p.skills) p.skills = [];
    if (!p.skills.includes(skill)) p.skills.push(skill);
    if (NET.online) sendAction({ type: 'DEBUG_SET_SKILLS', playerId: p.id, skills: p.skills });
    render();
}

// Debug: force the selected player into a given status. A KO'd player leaves
// the pitch, as they would after a real injury; standing one up again puts them
// back where they were only if they still have a square, so a KO'd player has to
// be dragged back on (debug mode already allows that).
function setStatusOfSelected(status) {
    const p = G.sel;
    if (!p) return;
    p.status = status;
    if (status === 'stunned') p.stunnedThisTurn = true;
    if (status === 'ko') { p.col = -1; p.row = -1; if (p.hasBall) { p.hasBall = false; G.ball.carrier = null; } }
    if (NET.online) sendAction({ type: 'DEBUG_SET_STATUS', playerId: p.id, status });
    render();
}

function removeSkillFromSelected(skill) {
    const p = G.sel;
    if (!p || !p.skills) return;
    p.skills = p.skills.filter(s => s !== skill);
    if (NET.online) sendAction({ type: 'DEBUG_SET_SKILLS', playerId: p.id, skills: p.skills });
    render();
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

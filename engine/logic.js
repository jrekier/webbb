// logic.js
// Core game state: creation, player helpers, activation, turn management.
// No DOM, no canvas. Works identically in browser and Node.js.

// ── createInitialState ────────────────────────────────────────────

function createInitialState() {
    return {
        active:        'home',
        turn:          1,
        half:          1,
        homeScore:     0,
        awayScore:     0,
        activated:     null,
        sel:           null,
        block:         null,
        blitz:         null,
        hasBlitzed:    false,
        hasDodged:     false,
        blitzFromProne: false,
        securingBall:  false,
        ball:          { col: 7, row: 13, carrier: null },
        players:       [],
    };
}

// ── Player helpers ────────────────────────────────────────────────

function playerAt(G, col, row) {
    return G.players.find(p => p.col === col && p.row === row) || null;
}

// A player only exerts a tackle zone if they are upright and on the pitch.
function isStanding(p) {
    return p.col >= 0 && p.status === 'active';
}

function isAdjacent(a, b) {
    return Math.abs(a.col - b.col) <= 1
        && Math.abs(a.row - b.row) <= 1
        && !(a.col === b.col && a.row === b.row);
}

function inTackleZoneOf(p, threat) {
    return isStanding(threat) && isAdjacent(p, threat);
}

// ── Move-state queries ────────────────────────────────────────────

function hasMovedYet(G) {
    if (!G.activated) return false;
    return G.activated.maLeft < G.activated.ma;
}

// True when cancel is still legal: not yet moved, or blitz declared from prone.
function canStillCancel(G) {
    if (!G.activated) return false;
    return !hasMovedYet(G) || G.blitzFromProne;
}

// ── Activation ────────────────────────────────────────────────────

function activatePlayer(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p) return null;
    if (p.side !== G.active) return null;
    if (p.usedAction) return null;
    if (G.activated) return null;
    if (p.status === 'stunned') return null;
    G.activated = p;
    G.sel       = p;
    return `${p.name} activated`;
}

function cancelActivation(G) {
    if (!G.activated) return null;
    if (!canStillCancel(G)) return null;
    const p    = G.activated;
    const name = p.name;
    if (G.blitz !== null) {
        if (G.blitzFromProne) {
            p.status = 'prone';
            p.maLeft = p.ma;
        }
        G.blitzFromProne = false;
        G.hasBlitzed     = false;
        G.blitz          = null;
    }
    G.securingBall = false;
    G.activated    = null;
    return `${name} — action cancelled`;
}

function endActivation(G) {
    if (!G.activated) return null;
    const name = G.activated.pos;
    G.activated.usedAction = true;
    G.activated = null;
    G.blitz     = null;
    G.hasDodged = false;
    return `${name} done`;
}

function endTurn(G) {
    if (G.activated) endActivation(G);
    for (const p of G.players) {
        if (p.side === G.active) {
            p.usedAction = false;
            p.maLeft     = p.ma;
            p.rushLeft   = 2;
            if (p.status === 'stunned') p.status = 'prone';
        }
    }
    G.active         = G.active === 'home' ? 'away' : 'home';
    G.sel            = null;
    G.hasBlitzed     = false;
    G.hasDodged      = false;
    G.blitzFromProne = false;
    G.securingBall   = false;
    if (G.active === 'home') G.turn += 1;
    return `Turn ${G.turn} · ${G.active.toUpperCase()}`;
}

// ── fixReferences ─────────────────────────────────────────────────
// After a JSON round-trip, G.activated / G.sel / ball.carrier become
// plain copies. Re-connect them to the live player objects by id.

function fixReferences(G) {
    if (G.activated) {
        G.activated = G.players.find(p => p.id === G.activated.id) || null;
    }
    if (G.sel) {
        G.sel = G.players.find(p => p.id === G.sel.id) || null;
    }
    if (G.ball && G.ball.carrier) {
        G.ball.carrier = G.players.find(p => p.id === G.ball.carrier.id) || null;
    }
    if (G.block && G.block.att) {
        G.block.att = G.players.find(p => p.id === G.block.att.id) || null;
        if (G.block.def)
            G.block.def = G.players.find(p => p.id === G.block.def.id) || null;
    }
    if (G.blitz && G.blitz.att) {
        G.blitz.att = G.players.find(p => p.id === G.blitz.att.id) || null;
        if (G.blitz.def)
            G.blitz.def = G.players.find(p => p.id === G.blitz.def.id) || null;
    }
}

// ── Formations ───────────────────────────────────────────────────

var FORMATION_HOME = [
    [4,13],[5,13],[6,13],
    [1,13],[9,13],
    [4,15],[6,15],
];

var FORMATION_AWAY = [
    [4,6],[5,6],[6,6],
    [1,6],[9,6],
    [4,4],[6,4],
];

function initFormations() {
    if (typeof module !== 'undefined') {
        module.exports.FORMATION_HOME = FORMATION_HOME;
        module.exports.FORMATION_AWAY = FORMATION_AWAY;
    }
}

// ── resetAfterTouchdown ───────────────────────────────────────────
// Resets all players to their formation positions and returns the
// ball to the centre. The team that did NOT score goes next (they
// receive the kickoff from the scoring team).

function resetAfterTouchdown(G, scoringSide) {
    const homePlayers = G.players.filter(p => p.side === 'home');
    const awayPlayers = G.players.filter(p => p.side === 'away');

    homePlayers.forEach((p, i) => {
        const [col, row] = FORMATION_HOME[i] || [5, 15];
        p.col = col; p.row = row;
        p.status = 'active'; p.hasBall = false;
        p.maLeft = p.ma; p.rushLeft = 2; p.usedAction = false;
    });
    awayPlayers.forEach((p, i) => {
        const [col, row] = FORMATION_AWAY[i] || [5, 4];
        p.col = col; p.row = row;
        p.status = 'active'; p.hasBall = false;
        p.maLeft = p.ma; p.rushLeft = 2; p.usedAction = false;
    });

    G.ball          = { col: 5, row: 10, carrier: null };
    G.activated     = null;
    G.sel           = null;
    G.block         = null;
    G.blitz         = null;
    G.hasBlitzed    = false;
    G.hasDodged     = false;
    G.blitzFromProne = false;
    G.securingBall  = false;
    G.active        = scoringSide === 'home' ? 'away' : 'home';
}

if (typeof module !== 'undefined') {
    module.exports = {
        createInitialState,
        playerAt, isStanding, isAdjacent, inTackleZoneOf,
        hasMovedYet, canStillCancel,
        activatePlayer, cancelActivation, endActivation, endTurn,
        fixReferences,
        FORMATION_HOME, FORMATION_AWAY, initFormations,
        resetAfterTouchdown,
    };
}

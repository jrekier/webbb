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
    return `${p.pos} activated`;
}

function cancelActivation(G) {
    if (!G.activated) return null;
    if (!canStillCancel(G)) return null;
    const p    = G.activated;
    const name = p.pos;
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

var FORMATIONS = {
    sevens: {
        home: [
            [4,13],[5,13],[6,13],
            [1,13],[9,13],
            [4,15],[7,7],
        ],
        away: [
            [4,6],[5,6],[6,6],
            [1,6],[9,6],
            [4,4],[6,4],
        ],
    },
    classic: {
        home: [
            [5,13],[7,13],[9,13],
            [3,15],[11,15],
            [5,16],[7,16],[9,16],
            [4,17],[7,17],[10,17],
        ],
        away: [
            [5,12],[7,12],[9,12],
            [3,10],[11,10],
            [5,9],[7,9],[9,9],
            [4,8],[7,8],[10,8],
        ],
    },
};

var FORMATION_HOME = [];
var FORMATION_AWAY = [];

function initFormations(key) {
    key = key || 'sevens';
    FORMATION_HOME = FORMATIONS[key].home;
    FORMATION_AWAY = FORMATIONS[key].away;
    if (typeof module !== 'undefined') {
        module.exports.FORMATION_HOME = FORMATION_HOME;
        module.exports.FORMATION_AWAY = FORMATION_AWAY;
    }
}

if (typeof module !== 'undefined') {
    module.exports = {
        createInitialState,
        playerAt, isStanding, isAdjacent, inTackleZoneOf,
        hasMovedYet, canStillCancel,
        activatePlayer, cancelActivation, endActivation, endTurn,
        fixReferences,
        FORMATIONS, FORMATION_HOME, FORMATION_AWAY, initFormations,
    };
}

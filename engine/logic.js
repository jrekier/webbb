// logic.js
// Core game state: creation, player helpers, activation, turn management.
// No DOM, no canvas. Works identically in browser and Node.js.

// ── createInitialState ────────────────────────────────────────────

function createInitialState() {
    return {
        phase:              'toss',   // 'toss' | 'setup' | 'play' | 'gameover'
        tossWinner:         null,
        kicker:             null,
        receiver:           null,
        firstHalfReceiver:  null,  // who received in half 1 — kicks off in half 2
        setupSide:          null,
        active:             'home',
        turn:               1,
        half:               1,
        score:              { home: 0, away: 0 },
        activated:          null,
        sel:                null,
        block:              null,
        blitz:              null,
        hasBlitzed:         false,
        hasPassed:          false,
        hasHandedOff:       false,
        handingOff:         false,
        hasDodged:          false,
        blitzFromProne:     false,
        securingBall:       false,
        stoodUpFromProne:   false,
        passing:            false,
        hasPassReroll:      false,
        passRerollChoice:   null,
        interceptionChoice: null,
        ball:               { col: 5, row: 10, carrier: null },
        players:            [],
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

function countTackleZones(G, side, col, row) {
    return G.players.filter(e =>
        e.side !== side && isStanding(e)
        && Math.abs(e.col - col) <= 1 && Math.abs(e.row - row) <= 1
        && !(e.col === col && e.row === row)
    ).length;
}

// ── Move-state queries ────────────────────────────────────────────

function hasMovedYet(G) {
    if (!G.activated) return false;
    return G.activated.maLeft < G.activated.ma;
}

// True when cancel is still legal: not yet moved, or blitz declared from prone.
function canStillCancel(G) {
    if (!G.activated) return false;
    return !hasMovedYet(G) || G.blitzFromProne || G.stoodUpFromProne;
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
    if (G.stoodUpFromProne) {
        p.status   = 'prone';
        p.maLeft   = p.ma;
        p.rushLeft = 2;
        G.stoodUpFromProne = false;
    }
    if (G.blitz !== null) {
        if (G.blitzFromProne) {
            p.status = 'prone';
            p.maLeft = p.ma;
        }
        G.blitzFromProne = false;
        G.hasBlitzed     = false;
        G.blitz          = null;
    }
    G.securingBall       = false;
    G.handingOff         = false;
    G.passing            = false;
    G.hasPassReroll      = false;
    G.passRerollChoice   = null;
    G.interceptionChoice = null;
    G.activated          = null;
    return `${name} — action cancelled`;
}

function endActivation(G) {
    if (!G.activated) return null;
    const name = G.activated.pos;
    G.activated.usedAction = true;
    G.activated    = null;
    G.blitz              = null;
    G.stoodUpFromProne   = false;
    G.hasDodged          = false;
    G.handingOff         = false;
    G.passing            = false;
    G.hasPassReroll      = false;
    G.passRerollChoice   = null;
    G.interceptionChoice = null;
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

    const justFinished = G.active;
    G.active         = G.active === 'home' ? 'away' : 'home';
    G.sel            = null;
    G.hasBlitzed     = false;
    G.hasPassed      = false;
    G.hasHandedOff   = false;
    G.hasDodged      = false;
    G.blitzFromProne = false;
    G.securingBall       = false;
    G.handingOff         = false;
    G.passing            = false;
    G.hasPassReroll      = false;
    G.passRerollChoice   = null;
    G.interceptionChoice = null;
    // Turn increments when the receiver becomes active again (completing a full round).
    if (G.active === G.receiver) G.turn += 1;

    // The kicker goes second, so they finish each round last.
    // Half 1 ends after both teams complete TURNS turns (kicker finishes turn TURNS).
    const firstHalfKicker = G.firstHalfReceiver === 'home' ? 'away' : 'home';
    if (G.half === 1 && justFinished === firstHalfKicker && G.turn > TURNS) {
        return startHalfTime(G);
    }
    // Half 2: receiver is firstHalfKicker, kicker is firstHalfReceiver.
    if (G.half === 2 && justFinished === G.firstHalfReceiver && G.turn > TURNS * 2) {
        return startGameOver(G);
    }

    return `Turn ${G.turn} · ${G.active.toUpperCase()}`;
}

// ── startHalfTime ────────────────────────────────────────────────
// KO roll for each KO'd player (4+ returns to dugout/reserves).
// Roles swap: half-1 receiver now kicks. Reset to setup.

function startHalfTime(G) {
    const koMsgs = [];
    for (const p of G.players) {
        if (p.status === 'ko') {
            const roll = Math.floor(Math.random() * 6) + 1;
            if (roll >= 4) {
                p.status = 'active';
                // Place off-pitch until setup positions them.
                p.col = -1; p.row = -1;
                koMsgs.push(`${p.name} recovers (rolled ${roll})`);
            } else {
                koMsgs.push(`${p.name} stays KO (rolled ${roll})`);
            }
        }
    }

    // Swap roles for second half
    G.half     = 2;
    G.turn     = TURNS + 1;
    G.kicker   = G.firstHalfReceiver;
    G.receiver = G.kicker === 'home' ? 'away' : 'home';

    // Reset available players and place them in default formation so they appear on pitch.
    // Compact indices: skip KO/casualty so there are no formation gaps.
    _placeInFormation(G.players.filter(p => p.side === 'home'), FORMATION_HOME, [5, 15]);
    _placeInFormation(G.players.filter(p => p.side === 'away'), FORMATION_AWAY, [5, 4]);

    G.activated          = null;
    G.sel                = null;
    G.block              = null;
    G.blitz              = null;
    G.hasBlitzed         = false;
    G.hasPassed          = false;
    G.hasHandedOff       = false;
    G.hasDodged          = false;
    G.blitzFromProne     = false;
    G.stoodUpFromProne   = false;
    G.securingBall       = false;
    G.handingOff         = false;
    G.passRerollChoice   = null;
    G.interceptionChoice = null;
    G.ball               = { col: -1, row: -1, carrier: null };
    G.phase              = 'setup';
    G.setupSide          = G.kicker;

    const koSummary = koMsgs.length ? ` KO rolls: ${koMsgs.join(', ')}.` : '';
    return `HALF TIME!${koSummary} Half 2: ${G.kicker.toUpperCase()} kicks off — set up your team.`;
}

// ── startGameOver ────────────────────────────────────────────────

function startGameOver(G) {
    G.phase     = 'gameover';
    G.activated = null;
    G.sel       = null;
    G.block     = null;
    G.blitz     = null;
    const { home, away } = G.score || { home: 0, away: 0 };
    const result = home > away ? 'HOME wins!' : away > home ? 'AWAY wins!' : 'Draw!';
    return `FULL TIME! ${result} Final score: ${home}–${away}`;
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

// ── _placeInFormation ─────────────────────────────────────────────
// Places available (non-KO, non-casualty) players into formation slots,
// compacting indices so missing players don't leave gaps.
// KO/casualty players are moved off-pitch.

function _placeInFormation(players, formation, fallback) {
    let fi = 0;
    for (const p of players) {
        if (p.status === 'ko' || p.status === 'casualty') {
            p.col = -1; p.row = -1;
            continue;
        }
        const [col, row] = formation[fi++] || fallback;
        p.col        = col;
        p.row        = row;
        p.status     = 'active';
        p.hasBall    = false;
        p.maLeft     = p.ma;
        p.rushLeft   = 2;
        p.usedAction = false;
    }
}

// ── resetAfterTouchdown ───────────────────────────────────────────
// Resets all players to their formation positions and returns the
// ball to the centre. The team that did NOT score goes next (they
// receive the kickoff from the scoring team).

function resetAfterTouchdown(G, scoringSide) {
    // KO recovery roll (4+) before resetting positions
    const koMsgs = [];
    for (const p of G.players) {
        if (p.status === 'ko') {
            const roll = Math.floor(Math.random() * 6) + 1;
            if (roll >= 4) {
                p.status = 'active';
                koMsgs.push(`${p.name} recovers (rolled ${roll})`);
            } else {
                koMsgs.push(`${p.name} stays KO (rolled ${roll})`);
            }
        }
    }
    if (koMsgs.length) G._koRollMsg = koMsgs.join(', ');

    _placeInFormation(G.players.filter(p => p.side === 'home'), FORMATION_HOME, [5, 15]);
    _placeInFormation(G.players.filter(p => p.side === 'away'), FORMATION_AWAY, [5, 4]);

    G.activated          = null;
    G.sel                = null;
    G.block              = null;
    G.blitz              = null;
    G.hasBlitzed         = false;
    G.hasPassed          = false;
    G.hasDodged          = false;
    G.blitzFromProne     = false;
    G.stoodUpFromProne   = false;
    G.securingBall       = false;
    G.handingOff         = false;
    G.hasHandedOff       = false;
    G.passRerollChoice   = null;
    G.interceptionChoice = null;

    // Scoring team kicks off the next drive; both sides set up again
    G.kicker    = scoringSide;
    G.receiver  = scoringSide === 'home' ? 'away' : 'home';
    G.phase     = 'setup';
    G.setupSide = G.kicker;
}

if (typeof module !== 'undefined') {
    module.exports = {
        createInitialState,
        playerAt, isStanding, isAdjacent, inTackleZoneOf, countTackleZones,
        hasMovedYet, canStillCancel,
        activatePlayer, cancelActivation, endActivation, endTurn,
        fixReferences,
        FORMATION_HOME, FORMATION_AWAY, initFormations,
        resetAfterTouchdown, startHalfTime, startGameOver,
    };
}

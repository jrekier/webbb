// helpers.js
// Read-only queries, game constants, and small player-state helpers.
// No dice rolls. Works identically in browser and Node.js.
// Everything in this file is a building block used by core.js and actions.js.

var COLS  = 11;
var ROWS  = 20;
var TURNS = 6;

// ── playerAt ──────────────────────────────────────────────────────

function playerAt(G, col, row) {
    return G.players.find(p => p.col === col && p.row === row) || null;
}

// ── isStanding ───────────────────────────────────────────────────
// A player only exerts a tackle zone if they are upright and on the pitch.

function isStanding(p) {
    return p.col >= 0 && p.status === 'active';
}

// ── isAdjacent ───────────────────────────────────────────────────

function isAdjacent(a, b) {
    return Math.abs(a.col - b.col) <= 1
        && Math.abs(a.row - b.row) <= 1
        && !(a.col === b.col && a.row === b.row);
}

// ── inTackleZoneOf ───────────────────────────────────────────────

function inTackleZoneOf(p, threat) {
    return isStanding(threat) && isAdjacent(p, threat);
}

// ── countTackleZones ─────────────────────────────────────────────

function countTackleZones(G, side, col, row) {
    return G.players.filter(e =>
        e.side !== side && isStanding(e)
        && Math.abs(e.col - col) <= 1 && Math.abs(e.row - row) <= 1
        && !(e.col === col && e.row === row)
    ).length;
}

// ── hasMovedYet ──────────────────────────────────────────────────

function hasMovedYet(G) {
    if (!G.activated) return false;
    return G.activated.maLeft < G.activated.ma;
}

// ── canStillCancel ───────────────────────────────────────────────
// True when cancel is still legal: not yet moved, or blitz declared from prone.

function canStillCancel(G) {
    if (!G.activated) return false;
    return !hasMovedYet(G) || G.blitzFromProne || G.stoodUpFromProne;
}

// ── isValidSetupSquare ───────────────────────────────────────────

function isValidSetupSquare(side, col, row) {
    if (side === 'home') return row >= 13 && row <= ROWS - 1;
    return row >= 0 && row <= 6;
}

// ── countAssists ─────────────────────────────────────────────────
// Returns effective strength of each side after counting assists.
// An assist is a standing friendly player adjacent to the target
// who is not themselves marked by any other enemy.

function countAssists(G, att, def) {
    const friends = (side) => G.players.filter(p =>
        p.side === side && isStanding(p) && p.id !== att.id && p.id !== def.id
    );

    const attAssists = friends(att.side).filter(helper => {
        if (!isAdjacent(helper, def)) return false;
        return !G.players.some(enemy =>
            enemy.side === def.side && isStanding(enemy)
            && enemy.id !== def.id && isAdjacent(helper, enemy)
        );
    }).length;

    const defAssists = friends(def.side).filter(helper => {
        if (!isAdjacent(helper, att)) return false;
        return !G.players.some(enemy =>
            enemy.side === att.side && isStanding(enemy)
            && enemy.id !== att.id && isAdjacent(helper, enemy)
        );
    }).length;

    return {
        attStr: att.st + attAssists,
        defStr: def.st + defAssists,
        attAssists,
        defAssists,
    };
}

// ── blockDiceCount ───────────────────────────────────────────────
// Returns { dice, chooser } based on strength comparison.

function blockDiceCount(attStr, defStr) {
    if      (attStr > defStr * 2) return { dice: 3, chooser: 'att' };
    else if (defStr > attStr * 2) return { dice: 3, chooser: 'def' };
    else if (attStr > defStr)     return { dice: 2, chooser: 'att' };
    else if (defStr > attStr)     return { dice: 2, chooser: 'def' };
    else                          return { dice: 1, chooser: 'att' };
}

// ── getBlockTargets ──────────────────────────────────────────────
// Adjacent standing enemies of att.

function getBlockTargets(G, att) {
    return G.players.filter(p =>
        p.side !== att.side && isStanding(p) && isAdjacent(att, p)
    );
}

// ── getPushSquares ────────────────────────────────────────────────
// Returns the valid squares the defender can be pushed into.

function getPushSquares(G, att, def) {
    const dc = Math.sign(def.col - att.col);
    const dr = Math.sign(def.row - att.row);

    const candidates = [];
    for (let sc = -1; sc <= 1; sc++) {
        for (let sr = -1; sr <= 1; sr++) {
            if (sc === 0 && sr === 0) continue;
            if (dc !== 0 && sc === -dc) continue;
            if (dr !== 0 && sr === -dr) continue;
            if (dc === 0 && sc !== 0 && sr !== dr) continue;
            if (dr === 0 && sr !== 0 && sc !== dc) continue;
            candidates.push([def.col + sc, def.row + sr]);
        }
    }

    const free = candidates.filter(([c, r]) =>
        c >= 0 && c < COLS && r >= 0 && r < ROWS && !playerAt(G, c, r)
    );
    // When no free in-bounds squares exist, all candidates are valid, including
    // out-of-bounds ones (crowd push).
    return free.length > 0 ? free : candidates;
}

// ── _isInKickerHalf ───────────────────────────────────────────────

function isInKickerHalf(kicker, row) {
    return kicker === 'home' ? row >= 13 : row <= 6;
}

// ── isValidKickTarget ─────────────────────────────────────────────

function isValidKickTarget(kicker, col, row) {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return false;
    return !isInKickerHalf(kicker, row);
}

// ── canMoveTo ─────────────────────────────────────────────────────
// Returns { allowed, needsrush, dodgerolltarget } for the given move.

function canMoveTo(G, player, col, row) {
    const dc    = Math.abs(player.col - col);
    const dr    = Math.abs(player.row - row);
    const minMA  = player.status === 'prone' ? 3 : 1;
    const allowed = (
        dc <= 1 && dr <= 1 && !(dc === 0 && dr === 0)
        && player.maLeft + player.rushLeft >= minMA
        && playerAt(G, col, row) === null
    );

    const needsrush = player.status === 'prone'
        ? player.maLeft < 3
        : player.maLeft === 0;

    const needsDodge = G.players.some(enemy =>
        enemy.side !== player.side && isStanding(enemy) && isAdjacent(player, enemy)
    );

    let dodgerolltarget = 0;
    if (needsDodge) {
        const destTZs = countTackleZones(G, player.side, col, row);
        dodgerolltarget = Math.min(player.ag + destTZs, 6);
    }

    return { allowed, needsrush, dodgerolltarget };
}

// ── markStunned ───────────────────────────────────────────────────
// Sets a player to stunned and marks the token so endTurn knows not
// to flip them to prone until the *next* turn their team is active.

function markStunned(p) {
    p.status          = 'stunned';
    p.stunnedThisTurn = true;
}

if (typeof module !== 'undefined') {
    module.exports = {
        COLS, ROWS, TURNS,
        playerAt, isStanding, isAdjacent, inTackleZoneOf, countTackleZones,
        hasMovedYet, canStillCancel,
        isValidSetupSquare,
        countAssists, blockDiceCount, getBlockTargets, getPushSquares,
        isInKickerHalf, isValidKickTarget,
        canMoveTo,
        markStunned,
    };
}

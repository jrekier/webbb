// helpers.js
// Read-only queries, game constants, and small player-state helpers.
// No dice rolls. Works identically in browser and Node.js.
// Everything in this file is a building block used by core.js and actions.js.

var COLS  = 11;
var ROWS  = 20;
var TURNS = 6;

var ALL_SKILLS = [
    'Always Hungry', 'Animal Savagery', 'Block', 'Bone Head', 'Catch',
    'Defensive', 'Diving Tackle', 'Dodge', 'Fend', 'Frenzy', 'Guard',
    'Juggernaut', 'Leader', 'Mighty Blow', 'Pass', 'Pro', 'Projectile Vomit',
    'Really Stupid', 'Right Stuff', 'Stab', 'Stand Firm', 'Strip Ball',
    'Stunty', 'Sure Hands', 'Tackle', 'Thick Skull', 'Throw Team-Mate', 'Wrestle',
];

// ── sqLabel ───────────────────────────────────────────────────────
// Human-readable square label: col → letter (A–K), row → 1-based number.
// e.g. sqLabel(0, 0) → "A1",  sqLabel(10, 19) → "K20"
function sqLabel(col, row) {
    return String.fromCharCode(65 + col) + (ROWS - row);
}

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
    return isStanding(threat) && !threat.distracted && isAdjacent(p, threat);
}

// ── countTackleZones ─────────────────────────────────────────────

function countTackleZones(G, side, col, row) {
    return G.players.filter(e =>
        e.side !== side && isStanding(e) && !e.distracted
        && Math.abs(e.col - col) <= 1 && Math.abs(e.row - row) <= 1
        && !(e.col === col && e.row === row)
    ).length;
}

// ── Team rerolls (incl. Leader) ───────────────────────────────────
// Leader grants one extra team reroll while a player with the skill is on the
// pitch (col >= 0 — i.e. not KO'd, casualty, or in reserves) and it has not
// been spent this half. teamRerollsLeft is the total a side may still spend.

function leaderRerollAvailable(G, side) {
    return !G.leaderRerollUsed?.[side]
        && G.players.some(p => p.side === side && p.col >= 0 && p.skills?.includes('Leader'));
}

function teamRerollsLeft(G, side) {
    return (G.rerolls?.[side] || 0) + (leaderRerollAvailable(G, side) ? 1 : 0);
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
    if (G.asRolled) return false;
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
        p.side === side && isStanding(p) && !p.distracted && p.id !== att.id && p.id !== def.id
    );

    const attAssists = friends(att.side).filter(helper => {
        if (!isAdjacent(helper, def)) return false;
        // Guard grants an assist even when marked — unless an adjacent opponent
        // switches it off with Defensive (during this helper's own turn).
        if (helper.skills?.includes('Guard')
            && !(G.active === helper.side && G.players.some(e =>
                e.side !== helper.side && isStanding(e) && !e.distracted
                && e.skills?.includes('Defensive') && isAdjacent(e, helper))))
            return true;
        return !G.players.some(enemy =>
            enemy.side === def.side && isStanding(enemy) && !enemy.distracted
            && enemy.id !== def.id && isAdjacent(helper, enemy)
        );
    }).length;

    const defAssists = friends(def.side).filter(helper => {
        if (!isAdjacent(helper, att)) return false;
        if (helper.skills?.includes('Guard')
            && !(G.active === helper.side && G.players.some(e =>
                e.side !== helper.side && isStanding(e) && !e.distracted
                && e.skills?.includes('Defensive') && isAdjacent(e, helper))))
            return true;
        return !G.players.some(enemy =>
            enemy.side === att.side && isStanding(enemy) && !enemy.distracted
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

    const needsDodge = countTackleZones(G, player.side, player.col, player.row) > 0;

    let dodgerolltarget = 0;
    if (needsDodge) {
        const destTZs = player.skills?.includes('Stunty')
            ? 0
            : countTackleZones(G, player.side, col, row);
        dodgerolltarget = Math.min(player.ag + destTZs, 6);
    }

    return { allowed, needsrush, dodgerolltarget };
}

// ── looseBallAt ───────────────────────────────────────────────────
// True when the ball is on the ground (no carrier) at the given square.

function looseBallAt(G, col, row) {
    return !G.ball.carrier && G.ball.col === col && G.ball.row === row;
}

// ── Weather ───────────────────────────────────────────────────────
// 2d6 table matching Blood Bowl weather rules.

var WEATHER_TABLE = [
    null, null,              // 0–1 unused
    'Sweltering Heat',       // 2
    'Very Sunny',            // 3
    'Perfect Conditions',    // 4
    'Perfect Conditions',    // 5
    'Perfect Conditions',    // 6
    'Perfect Conditions',    // 7
    'Perfect Conditions',    // 8
    'Perfect Conditions',    // 9
    'Perfect Conditions',    // 10
    'Pouring Rain',          // 11
    'Blizzard',              // 12
];

function rollWeather() {
    const roll = Math.floor(Math.random() * 6) + 1
               + Math.floor(Math.random() * 6) + 1;
    return WEATHER_TABLE[roll];
}

// ── isValidPerfectDefenseSquare ───────────────────────────────────
// True when the given square is in the kicking team's own half.
// Used during the Perfect Defense kickoff event.

function isValidPerfectDefenseSquare(kicker, col, row) {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return false;
    return isInKickerHalf(kicker, row);
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
        sqLabel,
        playerAt, isStanding, isAdjacent, inTackleZoneOf, countTackleZones,
        leaderRerollAvailable, teamRerollsLeft,
        hasMovedYet, canStillCancel,
        isValidSetupSquare,
        countAssists, blockDiceCount, getBlockTargets, getPushSquares,
        isInKickerHalf, isValidKickTarget,
        canMoveTo,
        looseBallAt,
        markStunned,
        WEATHER_TABLE, rollWeather,
        isValidPerfectDefenseSquare,
    };
}

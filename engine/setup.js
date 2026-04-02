// setup.js
// Coin toss and pre-game formation setup.
// Sevens setup rules:
//   Home sets up on rows 13–19, away on rows 0–6.
//   ≥3 players on the LoS (row 13 / row 6).
//   ≤2 players per wide zone (cols 0–1, cols 9–10).

function isValidSetupSquare(side, col, row) {
    if (side === 'home') return row >= 13 && row <= ROWS - 1;
    return row >= 0 && row <= 6;
}

// ── initToss ──────────────────────────────────────────────────────
// Picks a random toss winner. Returns the winning side.

function initToss(G) {
    G.phase      = 'toss';
    G.tossWinner = Math.random() < 0.5 ? 'home' : 'away';
    return G.tossWinner;
}

// ── chooseTossResult ──────────────────────────────────────────────
// Called when the toss winner picks 'kick' or 'receive'.
// Transitions to setup phase with the kicker setting up first.

function chooseTossResult(G, choice) {
    G.kicker    = choice === 'kick'
        ? G.tossWinner
        : (G.tossWinner === 'home' ? 'away' : 'home');
    G.receiver  = G.kicker === 'home' ? 'away' : 'home';
    G.phase     = 'setup';
    G.setupSide = G.kicker;
    return `${G.kicker.toUpperCase()} kicks off — set up your team.`;
}

// ── moveSetupPlayer ───────────────────────────────────────────────
// Drag a player to a new square during the setup phase.

function moveSetupPlayer(G, playerId, col, row) {
    if (G.phase !== 'setup') return null;
    const p = G.players.find(p => p.id === playerId);
    if (!p || p.side !== G.setupSide) return null;
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
    if (!isValidSetupSquare(p.side, col, row)) return null;
    if (G.players.some(o => o.id !== playerId && o.col === col && o.row === row)) return null;
    p.col = col;
    p.row = row;
    return 'ok';
}

// ── validateSetup ─────────────────────────────────────────────────
// Returns an array of rule violation strings. Empty = valid.

function validateSetup(G, side) {
    const players = G.players.filter(p => p.side === side);
    const errors  = [];
    const losRow  = side === 'home' ? 13 : 6;

    if (players.filter(p => p.row === losRow).length < 3)
        errors.push('At least 3 players must be on the line of scrimmage.');
    if (players.filter(p => p.col <= 1).length > 2)
        errors.push('Max 2 players in the left wide zone (cols 0–1).');
    if (players.filter(p => p.col >= 9).length > 2)
        errors.push('Max 2 players in the right wide zone (cols 9–10).');

    return errors;
}

// ── confirmSetup ──────────────────────────────────────────────────
// Lock in the current side's formation.
// Returns { ok, msg } or { errors }.

function confirmSetup(G, side) {
    if (G.phase !== 'setup' || G.setupSide !== side) return null;
    const errors = validateSetup(G, side);
    if (errors.length > 0) return { errors };

    if (side === G.kicker) {
        G.setupSide = G.receiver;
        return { ok: true, msg: `${G.receiver.toUpperCase()} — set up your team.` };
    }

    // Both sides confirmed — kick off
    G.phase     = 'play';
    G.active    = G.receiver;
    G.setupSide = null;
    G.ball      = { col: 5, row: 10, carrier: null };
    return { ok: true, msg: `Kick off! ${G.receiver.toUpperCase()} receives.` };
}

if (typeof module !== 'undefined') {
    module.exports = {
        isValidSetupSquare, initToss, chooseTossResult,
        moveSetupPlayer, validateSetup, confirmSetup,
    };
}

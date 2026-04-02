// ball.js
// Ball mechanics: scatter, pickup, secure, touchdown.

if (typeof module !== 'undefined') {
    var { playerAt, isStanding, endTurn, endActivation,
          resetAfterTouchdown } = require('./logic.js');
}

// ── _countTackleZones ─────────────────────────────────────────────
// Count opposing standing players whose tackle zone covers (col, row).

function _countTackleZones(G, side, col, row) {
    return G.players.filter(e =>
        e.side !== side && isStanding(e)
        && Math.abs(e.col - col) <= 1 && Math.abs(e.row - row) <= 1
        && !(e.col === col && e.row === row)
    ).length;
}

// ── scatterBall ───────────────────────────────────────────────────
// Moves the loose ball one square in a random d8 direction.
// Standing players on the landing square attempt a catch (AG + TZs).
// Prone/stunned players let the ball bounce (re-scatter).
// Returns a log string.

function scatterBall(G) {
    const DC = [ 0, 1, 1, 1, 0,-1,-1,-1];
    const DR = [-1,-1, 0, 1, 1, 1, 0,-1];
    const dir = Math.floor(Math.random() * 8);
    const nc  = G.ball.col + DC[dir];
    const nr  = G.ball.row + DR[dir];

    if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) {
        G.ball.col = Math.max(0, Math.min(COLS - 1, nc < 0 ? 0 : nc >= COLS ? COLS - 1 : nc));
        G.ball.row = Math.max(0, Math.min(ROWS - 1, nr < 0 ? 0 : nr >= ROWS ? ROWS - 1 : nr));
        return `Ball scattered out of bounds — placed at (${G.ball.col},${G.ball.row}).`;
    }

    G.ball.col = nc;
    G.ball.row = nr;

    const lander = playerAt(G, nc, nr);
    if (!lander) return `Ball scattered to (${nc},${nr}).`;

    if (!isStanding(lander)) {
        return `Ball bounces off ${lander.pos}. ` + scatterBall(G);
    }

    const tzs    = _countTackleZones(G, lander.side, nc, nr);
    const target = Math.min(lander.ag + tzs, 6);
    const roll   = Math.floor(Math.random() * 6) + 1;
    if (roll >= target || roll === 6) {
        lander.hasBall = true;
        G.ball.carrier = lander;
        return `Ball scattered to (${nc},${nr}) — ${lander.pos} catches it! (rolled ${roll}, needed ${target}+)`;
    }
    return `${lander.pos} fails to catch (rolled ${roll}, needed ${target}+). ` + scatterBall(G);
}

// ── tryPickup ─────────────────────────────────────────────────────
// Called when a player moves onto the ball's square.
// AG roll modified by opposing tackle zones on that square.

function tryPickup(G, p) {
    if (G.ball.carrier || G.ball.col !== p.col || G.ball.row !== p.row) return null;
    const tzs    = _countTackleZones(G, p.side, p.col, p.row);
    const target = Math.min(p.ag + tzs, 6);
    const roll   = Math.floor(Math.random() * 6) + 1;
    if (roll >= target || roll === 6) {
        p.hasBall      = true;
        G.ball.carrier = p;
        return `${p.name} picks up the ball (rolled ${roll}, needed ${target}+).`;
    }
    const scatterMsg = scatterBall(G);
    endTurn(G);
    return `${p.name} fails to pick up (rolled ${roll}, needed ${target}+). ${scatterMsg} TURNOVER`;
}

// ── checkTouchdown ────────────────────────────────────────────────
// Returns a score message if p just scored, null otherwise.

function checkTouchdown(G, p) {
    if (!p.hasBall) return null;
    const scored =
        (p.side === 'away' && p.row === ROWS - 1) ||
        (p.side === 'home' && p.row === 0);
    if (!scored) return null;
    G.score         = G.score || { home: 0, away: 0 };
    G.score[p.side] += 1;
    const msg = `TOUCHDOWN! ${p.side.toUpperCase()} scores! (${G.score.home}–${G.score.away})`;
    resetAfterTouchdown(G, p.side);
    return msg;
}

// ── _doSecureRoll ─────────────────────────────────────────────────
// Rolls 2+ for Secure the Ball. Called once the player is on the
// ball's square. Ends activation on success; turnover on failure.

function _doSecureRoll(G, p) {
    const tzs    = _countTackleZones(G, p.side, G.ball.col, G.ball.row);
    const target = Math.min(2 + tzs, 6);
    const roll   = Math.floor(Math.random() * 6) + 1;
    G.securingBall = false;
    if (roll >= target || roll === 6) {
        p.hasBall      = true;
        G.ball.carrier = p;
        endActivation(G);
        return `${p.name} secures the ball (rolled ${roll}, needed ${target}+).`;
    }
    const scatterMsg = scatterBall(G);
    endTurn(G);
    return `${p.name} fails to secure (rolled ${roll}). ${scatterMsg} TURNOVER`;
}

// ── secureBall ────────────────────────────────────────────────────
// Secure the Ball action (BB2025): activates player in securing mode.
// If already on the ball, rolls immediately. Otherwise the player
// moves normally and the 2+ fires when they step onto the ball square.

function secureBall(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p || p.side !== G.active || p.usedAction || G.activated) return null;
    if (p.status === 'stunned') return null;
    if (G.ball.carrier) return null;

    // Standing player already on the ball — resolve immediately
    if (p.status === 'active' && p.col === G.ball.col && p.row === G.ball.row) {
        return _doSecureRoll(G, p);
    }

    G.activated    = p;
    G.sel          = p;
    G.securingBall = true;
    return `${p.name} declares Secure Ball — move to the ball.`;
}

// ── Kick mechanics ────────────────────────────────────────────────

function _isInKickerHalf(kicker, row) {
    return kicker === 'home' ? row >= 13 : row <= 6;
}

function isValidKickTarget(kicker, col, row) {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return false;
    return !_isInKickerHalf(kicker, row);
}

// Kicker picks an aim square; 2d6 (take min) scatter distance + d8 direction.
// Touchback if the ball leaves the pitch or lands in the kicker's half.
function declareKick(G, col, row) {
    if (G.phase !== 'kick') return null;
    if (!isValidKickTarget(G.kicker, col, row)) return null;

    const DC   = [ 0, 1, 1, 1, 0,-1,-1,-1];
    const DR   = [-1,-1, 0, 1, 1, 1, 0,-1];
    const DIRS = ['N','NE','E','SE','S','SW','W','NW'];

    const d6a  = Math.floor(Math.random() * 6) + 1;
    const d6b  = Math.floor(Math.random() * 6) + 1;
    const dist = Math.min(d6a, d6b);
    const dir  = Math.floor(Math.random() * 8);

    const nc = col + DC[dir] * dist;
    const nr = row + DR[dir] * dist;

    let msg = `Kick aimed (${col},${row}): ${d6a}+${d6b} → ${dist} sq ${DIRS[dir]}.`;

    const outOfBounds  = nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS;
    const inKickerHalf = !outOfBounds && _isInKickerHalf(G.kicker, nr);

    if (outOfBounds || inKickerHalf) {
        G.ball  = { col: -1, row: -1, carrier: null };
        G.phase = 'touchback';
        return msg + ` Ball out of play — TOUCHBACK! ${G.receiver.toUpperCase()} picks a player.`;
    }

    G.ball = { col: nc, row: nr, carrier: null };
    msg   += ` Lands at (${nc},${nr}).`;

    const lander = playerAt(G, nc, nr);
    if (lander && isStanding(lander)) {
        const tzs    = _countTackleZones(G, lander.side, nc, nr);
        const target = Math.min(lander.ag + tzs, 6);
        const roll   = Math.floor(Math.random() * 6) + 1;
        if (roll >= target || roll === 6) {
            lander.hasBall = true;
            G.ball.carrier = lander;
            msg += ` ${lander.name} catches the kick! (${roll} vs ${target}+)`;
        } else {
            msg += ` ${lander.name} fails to catch (${roll} vs ${target}+). ` + scatterBall(G);
        }
    }

    G.phase  = 'play';
    G.active = G.receiver;
    return msg;
}

// Receiver nominates a player to receive a touchback.
function touchbackGiveBall(G, playerId) {
    if (G.phase !== 'touchback') return null;
    const p = G.players.find(p => p.id === playerId);
    if (!p || p.side !== G.receiver) return null;
    if (p.status === 'ko' || p.status === 'casualty' || p.col < 0) return null;

    p.hasBall      = true;
    G.ball.col     = p.col;
    G.ball.row     = p.row;
    G.ball.carrier = p;

    G.phase  = 'play';
    G.active = G.receiver;
    return `${p.name} receives the touchback.`;
}

if (typeof module !== 'undefined') {
    module.exports = {
        _countTackleZones, scatterBall, tryPickup, checkTouchdown,
        _doSecureRoll, secureBall,
        isValidKickTarget, declareKick, touchbackGiveBall,
    };
}

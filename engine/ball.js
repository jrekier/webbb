// ball.js
// Ball mechanics: scatter, pickup, secure, touchdown.

if (typeof module !== 'undefined') {
    var { playerAt, isStanding, endTurn, endActivation,
          resetAfterTouchdown, countTackleZones } = require('./logic.js');
}

// ── throwIn ──────────────────────────────────────────────────────
// Ball left the pitch from lastCol/lastRow heading toward nc/nr.
// The crowd throws it back: pick 1 of 3 inward directions (1d6),
// travel 2d6-1 squares. Repeat if it goes out again.

function throwIn(G, lastCol, lastRow, nc, nr) {
    // Determine which edge was crossed and the two tangential directions.
    // The three valid throw-in directions are: straight in + two diagonals.
    const fromLeft  = nc < 0;
    const fromRight = nc >= COLS;
    const fromTop   = nr < 0;
    const fromBot   = nr >= ROWS;

    // Inward unit vector (perpendicular to the crossed edge)
    const inDC = fromLeft ? 1 : fromRight ? -1 : 0;
    const inDR = fromTop  ? 1 : fromBot   ? -1 : 0;

    // Tangential unit vectors along the edge
    // If we crossed a vertical edge (left/right), tangent is along rows.
    // If we crossed a horizontal edge (top/bot), tangent is along cols.
    const tanDC = (fromLeft || fromRight) ? 0 : 1;
    const tanDR = (fromLeft || fromRight) ? 1 : 0;

    // Three candidate directions: in, in+tan, in-tan
    const dirs = [
        [ inDC,        inDR        ],
        [ inDC + tanDC, inDR + tanDR ],
        [ inDC - tanDC, inDR - tanDR ],
    ];

    const pick = Math.floor(Math.random() * 6) % 3; // 1d6 → 0,1,2
    const [dc, dr] = dirs[pick];
    const dist = Math.floor(Math.random() * 6) + Math.floor(Math.random() * 6) + 1; // 2d6-1 (min 1)

    // Start from the last in-bounds square
    const tc = lastCol + dc * dist;
    const tr = lastRow + dr * dist;

    const dirLabel = ['straight in', 'diagonal +', 'diagonal −'][pick];
    const msg = `Throw-in: ${dirLabel}, ${dist} sq → (${tc},${tr}).`;

    if (tc < 0 || tc >= COLS || tr < 0 || tr >= ROWS) {
        // Still out — repeat from the last in-bounds point along this edge
        const edgeC = Math.max(0, Math.min(COLS - 1, tc));
        const edgeR = Math.max(0, Math.min(ROWS - 1, tr));
        return msg + ` Out again. ` + throwIn(G, edgeC, edgeR, tc, tr);
    }

    G.ball.col = tc;
    G.ball.row = tr;

    const lander = playerAt(G, tc, tr);
    if (!lander) return msg;
    if (!isStanding(lander)) return msg + ` Bounces off ${lander.name}. ` + scatterBall(G);

    const tzs    = countTackleZones(G, lander.side, tc, tr);
    const target = Math.min(lander.ag + tzs, 6);
    const roll   = Math.floor(Math.random() * 6) + 1;
    if (roll >= target || roll === 6) {
        lander.hasBall = true;
        G.ball.carrier = lander;
        return msg + ` ${lander.name} catches it! (${roll} vs ${target}+)`;
    }
    return msg + ` ${lander.name} fails to catch (${roll} vs ${target}+). ` + scatterBall(G);
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
        return `Ball scattered out of bounds. ` + throwIn(G, G.ball.col, G.ball.row, nc, nr);
    }

    G.ball.col = nc;
    G.ball.row = nr;

    const lander = playerAt(G, nc, nr);
    if (!lander) return `Ball scattered to (${nc},${nr}).`;

    if (!isStanding(lander)) {
        return `Ball bounces off ${lander.pos}. ` + scatterBall(G);
    }

    const tzs    = countTackleZones(G, lander.side, nc, nr);
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
    const tzs    = countTackleZones(G, p.side, p.col, p.row);
    const target = Math.min(p.ag + tzs, 6);
    let roll     = Math.floor(Math.random() * 6) + 1;
    let extra    = '';

    if (roll !== 6 && roll < target && p.skills?.includes('Sure Hands')) {
        const reroll = Math.floor(Math.random() * 6) + 1;
        extra = ` Uses Sure Hands, rerolls: ${reroll}.`;
        roll  = reroll;
    }

    if (roll >= target || roll === 6) {
        p.hasBall      = true;
        G.ball.carrier = p;
        return `${p.name} picks up the ball (rolled ${roll}, needed ${target}+).${extra}`;
    }
    const scatterMsg = scatterBall(G);
    endTurn(G);
    return `${p.name} fails to pick up (rolled ${roll}, needed ${target}+).${extra} ${scatterMsg} TURNOVER`;
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
    let msg = `TOUCHDOWN! ${p.side.toUpperCase()} scores! (${G.score.home}–${G.score.away})`;
    resetAfterTouchdown(G, p.side);
    if (G._koRollMsg) { msg += ` KO rolls: ${G._koRollMsg}.`; G._koRollMsg = null; }
    return msg;
}

// ── doSecureRoll ─────────────────────────────────────────────────
// Rolls 2+ for Secure the Ball. Called once the player is on the
// ball's square. Ends activation on success; turnover on failure.

function doSecureRoll(G, p) {
    const tzs    = countTackleZones(G, p.side, G.ball.col, G.ball.row);
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
        return doSecureRoll(G, p);
    }

    G.activated    = p;
    G.sel          = p;
    G.securingBall = true;
    return `${p.name} declares Secure Ball — move to the ball.`;
}

// ── Pass Action ───────────────────────────────────────────────────

// Scatter ball N times (no intermediate catch checks — used for
// the Scatter(3) on an inaccurate pass). Returns { msg, done }
// where done=true means the ball went out of bounds and was already
// resolved via throwIn (caller should return msg immediately).

function _scatterNTimes(G, n) {
    const DC = [ 0, 1, 1, 1, 0,-1,-1,-1];
    const DR = [-1,-1, 0, 1, 1, 1, 0,-1];
    let msg = '';
    for (let i = 0; i < n; i++) {
        const dir = Math.floor(Math.random() * 8);
        const nc  = G.ball.col + DC[dir];
        const nr  = G.ball.row + DR[dir];
        if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) {
            msg += throwIn(G, G.ball.col, G.ball.row, nc, nr);
            return { msg, done: true };
        }
        G.ball.col = nc;
        G.ball.row = nr;
        msg += `(${nc},${nr}) `;
    }
    return { msg: msg.trim(), done: false };
}

// ── _catchAtSquare ────────────────────────────────────────────────
// Attempt a catch by whoever is standing on (col,row).
// bouncePenalty adds +1 to the target (scattered/bounced ball).
// Appends to and returns the log string; updates G.ball.carrier.

function _catchAtSquare(G, col, row, bouncePenalty) {
    const lander = playerAt(G, col, row);
    if (!lander) return ' Ball hits the ground. ' + scatterBall(G);
    if (!isStanding(lander)) return ` ${lander.name} is prone. ` + scatterBall(G);

    const tzs    = countTackleZones(G, lander.side, col, row);
    const target = Math.min(lander.ag + (bouncePenalty ? 1 : 0) + tzs, 6);
    let roll     = Math.floor(Math.random() * 6) + 1;
    let extra    = '';

    if (roll !== 6 && roll < target && lander.skills?.includes('Catch')) {
        const reroll = Math.floor(Math.random() * 6) + 1;
        extra = ` Uses Catch skill, rerolls: ${reroll}.`;
        roll  = reroll;
    }

    if (roll >= target || roll === 6) {
        lander.hasBall = true;
        G.ball.carrier = lander;
        const tdMsg    = checkTouchdown(G, lander);
        const catchMsg = `${lander.name} catches it! (${roll} vs ${target}+)${extra}`;
        return tdMsg ? ` ${catchMsg} ${tdMsg}` : ` ${catchMsg}`;
    }
    return ` ${lander.name} fails to catch (${roll} vs ${target}+).${extra} ` + scatterBall(G);
}

// ── _checkPassTurnover ────────────────────────────────────────────
// After the ball has fully settled, trigger a turnover if it did not
// end up in the hands of a player on passerSide.
// A touchdown (G.phase !== 'play') is never a turnover.

function _checkPassTurnover(G, passerSide, msg) {
    if (G.phase !== 'play') return msg;                              // touchdown scored
    if (G.ball.carrier && G.ball.carrier.side === passerSide) return msg; // friendly possession
    endTurn(G);
    return msg + ' TURNOVER';
}


function _resolveAccuratePass(G, p, targetCol, targetRow, msg) {
    const passerSide = p.side;
    p.hasBall      = false;
    G.ball.carrier = null;
    G.ball.col     = targetCol;
    G.ball.row     = targetRow;
    G.passing      = false;
    G.hasPassed    = true;
    endActivation(G);

    msg += `Accurate! Ball lands at (${targetCol},${targetRow}).`;
    msg += _catchAtSquare(G, targetCol, targetRow, false);

    return _checkPassTurnover(G, passerSide, msg);
}

// ── declarePass ────────────────────────────────────────────────────
// Activates the ball-carrier in pass mode. The player may make a
// free Move Action first, then call throwBall to resolve the throw.

function declarePass(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p || p.side !== G.active || p.usedAction || G.activated) return null;
    if (p.status === 'stunned') return null;
    if (G.hasPassed) return null;

    G.activated     = p;
    G.sel           = p;
    G.passing       = true;
    G.hasPassReroll = false;
    return `${p.name} declares Pass — move to the ball if needed, then press Throw.`;
}

// ── getInterceptors ───────────────────────────────────────────────
// Returns standing opposing players whose square overlaps the pass
// trajectory — a 2-square-wide corridor centred on the line from
// the passer to the target. Used both for UI feedback and resolution.

function _ptSegDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-10) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function getInterceptors(G, passer, targetCol, targetRow) {
    const ax = passer.col + 0.5, ay = passer.row + 0.5;
    const bx = targetCol  + 0.5, by = targetRow  + 0.5;
    return G.players.filter(p => {
        if (p.side === passer.side) return false;
        if (!isStanding(p)) return false;
        if (p.col === passer.col && p.row === passer.row) return false;
        if (p.col === targetCol  && p.row === targetRow)  return false;
        // Any part of the player's square within 1 cell of the line
        return _ptSegDist(p.col + 0.5, p.row + 0.5, ax, ay, bx, by) < 1.0;
    });
}

// ── _doFumble ─────────────────────────────────────────────────────

function _doFumble(G, p, msg) {
    p.hasBall      = false;
    G.ball.carrier = null;
    G.ball.col     = p.col;
    G.ball.row     = p.row;
    G.passing      = false;
    G.hasPassed    = true;
    const sm = scatterBall(G);
    endTurn(G);
    return msg + `FUMBLE! ${sm} TURNOVER`;
}

// ── _continueThrow ────────────────────────────────────────────────
// Shared second half of a throw: pre-scatter if inaccurate, check
// interceptors, then resolve or suspend into interceptionChoice.
// Called by throwBall and resolvePassReroll to avoid duplication.

function _continueThrow(G, p, targetCol, targetRow, accurate, msg) {
    let actualCol = targetCol, actualRow = targetRow;
    let scatterMsg = '';

    if (!accurate) {
        p.hasBall      = false;
        G.ball.carrier = null;
        G.ball.col     = targetCol;
        G.ball.row     = targetRow;
        msg += `Inaccurate! Ball scatters ×3 from (${targetCol},${targetRow}): `;
        const sc = _scatterNTimes(G, 3);
        scatterMsg = sc.msg + ' ';
        msg       += scatterMsg;
        if (sc.done) {
            G.passing   = false;
            G.hasPassed = true;
            const passerSide = p.side;
            endActivation(G);
            return _checkPassTurnover(G, passerSide, msg);
        }
        actualCol = G.ball.col;
        actualRow = G.ball.row;
    }

    const interceptors = getInterceptors(G, p, actualCol, actualRow);
    if (interceptors.length > 0) {
        G.passing            = false;
        G.interceptionChoice = {
            declaredCol: targetCol, declaredRow: targetRow,
            actualCol,   actualRow,
            accurate,    scatterMsg,
            interceptorIds: interceptors.map(i => i.id),
        };
        return msg + `Pass in flight — opponent must choose an interceptor.`;
    }

    if (accurate) return _resolveAccuratePass(G, p, targetCol, targetRow, msg);
    return _resolveInaccurateAtLanding(G, p, actualCol, actualRow, msg);
}

// ── throwBall ─────────────────────────────────────────────────────
// BB2025 outcomes:
//   Natural 1           → Fumble (scatter from passer, TURNOVER)
//   Roll < target       → Inaccurate (Scatter ×3 from target square)
//   Roll ≥ target or 6  → Accurate (catch attempt at target square)
// Pass skill: one re-roll on Fumble OR Inaccurate (player's choice).

function throwBall(G, targetCol, targetRow) {
    if (!G.passing || !G.activated) return null;
    const p = G.activated;
    if (!p.hasBall) return null;
    if (targetCol < 0 || targetCol >= COLS || targetRow < 0 || targetRow >= ROWS) return null;

    const dist  = Math.max(Math.abs(p.col - targetCol), Math.abs(p.row - targetRow));
    const range = dist <= 3 ? { label: 'Quick Pass', mod: 0 }
                : dist <= 6 ? { label: 'Short Pass',  mod: 1 }
                : dist <= 9 ? { label: 'Long Pass',   mod: 2 }
                :             { label: 'Long Bomb',   mod: 3 };

    const tzs     = countTackleZones(G, p.side, p.col, p.row);
    const target  = Math.min(p.pa + range.mod + tzs, 6);
    const rawRoll = Math.floor(Math.random() * 6) + 1;
    const msg     = `${p.name} throws a ${range.label} (PA ${p.pa}+, +${range.mod + tzs} mods → ${target}+): rolled ${rawRoll}. `;

    const isFumble = rawRoll === 1;
    const accurate = !isFumble && (rawRoll === 6 || rawRoll >= target);

    // Pass skill: offer one re-roll on Fumble or Inaccurate (player's choice)
    if ((isFumble || !accurate) && p.skills?.includes('Pass') && !G.hasPassReroll) {
        G.passing          = false;
        G.passRerollChoice = { targetCol, targetRow, target, msg, isFumble };
        return msg + (isFumble ? `Fumble` : `Inaccurate`) + ` — Pass skill available.`;
    }

    if (isFumble) return _doFumble(G, p, msg);
    return _continueThrow(G, p, targetCol, targetRow, accurate, msg);
}

// ── resolvePassReroll ─────────────────────────────────────────────
// Called after throwBall suspends into G.passRerollChoice.
// use=true: spend the Pass skill reroll. use=false: accept the result.

function resolvePassReroll(G, use) {
    if (!G.passRerollChoice) return null;
    const { targetCol, targetRow, target, msg: prevMsg, isFumble } = G.passRerollChoice;
    G.passRerollChoice = null;
    const p = G.activated;
    if (!p) return null;

    if (!use) {
        if (isFumble) return _doFumble(G, p, prevMsg);
        return _continueThrow(G, p, targetCol, targetRow, false, prevMsg);
    }

    G.hasPassReroll  = true;
    const reroll     = Math.floor(Math.random() * 6) + 1;
    const msg        = prevMsg + `Uses Pass skill, rerolls: ${reroll}. `;
    if (reroll === 1) return _doFumble(G, p, msg);
    const accurate   = reroll === 6 || reroll >= target;
    return _continueThrow(G, p, targetCol, targetRow, accurate, msg);
}

// ── _resolveInaccurateAtLanding ───────────────────────────────────
// Ball has already been pre-scattered to G.ball.col/row (= actualCol,actualRow)
// and p.hasBall has already been cleared. Attempt catch and check turnover.

function _resolveInaccurateAtLanding(G, p, actualCol, actualRow, msg) {
    const passerSide = p.side;
    G.passing   = false;
    G.hasPassed = true;
    endActivation(G);
    msg += _catchAtSquare(G, actualCol, actualRow, true);
    return _checkPassTurnover(G, passerSide, msg);
}

// ── chooseInterceptor ─────────────────────────────────────────────
// Called after throwBall suspends into G.interceptionChoice.
// interceptorId: a player id (attempt interception) or null (decline).

function chooseInterceptor(G, interceptorId) {
    if (!G.interceptionChoice) return null;
    const { declaredCol, declaredRow, actualCol, actualRow,
            accurate, scatterMsg, interceptorIds } = G.interceptionChoice;
    G.interceptionChoice = null;
    const p = G.activated;
    if (!p) return null;

    let msg = scatterMsg || '';

    if (interceptorId !== null) {
        const interceptor = G.players.find(pl => pl.id === interceptorId
                                              && interceptorIds.includes(pl.id));
        if (interceptor) {
            const iMod    = accurate ? 3 : 2;
            const iTzs    = countTackleZones(G, interceptor.side, interceptor.col, interceptor.row);
            const iTarget = Math.min(interceptor.ag + iMod + iTzs, 6);
            const iRoll   = Math.floor(Math.random() * 6) + 1;
            const iHit    = iRoll === 6 || iRoll >= iTarget;
            msg += `${interceptor.name} intercepts (${iRoll} vs ${iTarget}+): ${iHit ? 'SUCCESS!' : 'failed.'} `;
            if (iHit) {
                interceptor.hasBall = true;
                G.ball.carrier      = interceptor;
                G.ball.col          = interceptor.col;
                G.ball.row          = interceptor.row;
                p.hasBall           = false;
                G.passing           = false;
                G.hasPassed         = true;
                endTurn(G);
                return msg + 'TURNOVER';
            }
        }
    }

    if (accurate) return _resolveAccuratePass(G, p, declaredCol, declaredRow, msg);
    return _resolveInaccurateAtLanding(G, p, actualCol, actualRow, msg);
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
        const tzs    = countTackleZones(G, lander.side, nc, nr);
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
        scatterBall, throwIn, tryPickup, checkTouchdown,
        doSecureRoll, secureBall,
        declarePass, throwBall, resolvePassReroll, getInterceptors, chooseInterceptor,
        isValidKickTarget, declareKick, touchbackGiveBall,
    };
}

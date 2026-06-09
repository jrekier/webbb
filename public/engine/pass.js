// pass.js
// The passing game: the Pass action, Hand-off, and interception.

if (typeof module !== 'undefined') {
    var { COLS, ROWS, countTackleZones, isAdjacent, isStanding, sqLabel } = require('./helpers.js');
    var { d6 } = require('./dice.js');
    var { endActivation, endTurn } = require('./core.js');
    var { _catchAtSquare, _offerReroll, _scatterNTimes, _traitChecks, pn, scatterBall } = require('./resolve.js');
}

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

    msg += `Accurate! Ball lands at ${sqLabel(targetCol,targetRow)}.`;
    msg += _catchAtSquare(G, targetCol, targetRow, false);

    return _checkPassTurnover(G, passerSide, msg);
}

// ── declarePass ────────────────────────────────────────────────────
// Activates the ball-carrier in pass mode. The player may make a
// free Move Action first, then call throwBall to resolve the throw.

function declarePass(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p) return null;
    const t = _traitChecks(G, p, false);
    if (t.abort) return t.msg;
    const prefix = t.msg;

    G.activated     = p;
    G.sel           = p;
    G.passing       = true;
    G.hasPassReroll = false;
    if (G.animalSavagery) return prefix;
    return (prefix ? prefix + ' ' : '') + `${pn(p)} [[skill:declares Pass]] — move to the ball if needed, then press Throw.`;
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
    const dx = bx - ax, dy = by - ay;
    return G.players.filter(p => {
        if (p.side === passer.side) return false;
        if (!isStanding(p)) return false;
        if (p.col === passer.col && p.row === passer.row) return false;
        if (p.col === targetCol  && p.row === targetRow)  return false;
        // Exclude players whose centre lies outside the passer→target range.
        const cx = p.col + 0.5, cy = p.row + 0.5;
        const proj = (cx - ax) * dx + (cy - ay) * dy;
        if (proj <= 0) return false;                          // behind passer
        if (proj >= dx * dx + dy * dy) return false;          // beyond target
        // Corridor overlaps the player's square if the nearest point of that
        // square (corners + centre) is within 1 cell of the segment.
        const pts = [
            [p.col,       p.row      ],
            [p.col + 1,   p.row      ],
            [p.col,       p.row + 1  ],
            [p.col + 1,   p.row + 1  ],
            [p.col + 0.5, p.row + 0.5],
        ];
        return pts.some(([px, py]) => _ptSegDist(px, py, ax, ay, bx, by) < 1.0);
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
// interceptors, then resolve or suspend into G.pending (kind 'intercept').
// Called by throwBall and resolvePassReroll to avoid duplication.

function _continueThrow(G, p, targetCol, targetRow, accurate, msg) {
    let actualCol = targetCol, actualRow = targetRow;
    let scatterMsg = '';

    if (!accurate) {
        p.hasBall      = false;
        G.ball.carrier = null;
        G.ball.col     = targetCol;
        G.ball.row     = targetRow;
        msg += `Inaccurate! Ball scatters ×3 from ${sqLabel(targetCol,targetRow)}: `;
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
        G.passing = false;
        G.pending = {
            kind: 'intercept', side: p.side === 'home' ? 'away' : 'home',
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

    const dx    = Math.abs(p.col - targetCol);
    const dy    = Math.abs(p.row - targetRow);
    const dist  = Math.floor(Math.sqrt(dx * dx + dy * dy));
    const range = dist <= 3 ? { label: 'Quick Pass', mod: 0 }
                : dist <= 6 ? { label: 'Short Pass',  mod: 1 }
                : dist <= 9 ? { label: 'Long Pass',   mod: 2 }
                :             { label: 'Long Bomb',   mod: 3 };

    const tzs     = countTackleZones(G, p.side, p.col, p.row);
    const target  = Math.min(p.pa + range.mod + tzs, 6);
    const rawRoll = Math.floor(Math.random() * 6) + 1;
    const msg     = `${pn(p)} [[skill:throws]] a ${range.label} (PA ${p.pa}+, +${range.mod + tzs} mods → ${target}+): rolled ${rawRoll}. `;

    const isFumble = rawRoll === 1;
    const accurate = !isFumble && (rawRoll === 6 || rawRoll >= target);

    // Pass skill: offer one re-roll on Fumble or Inaccurate (player's choice)
    if ((isFumble || !accurate) && p.skills?.includes('Pass') && !G.hasPassReroll) {
        G.passing = false;
        G.pending = { kind: 'passReroll', side: p.side, targetCol, targetRow, target, msg, isFumble };
        return msg + (isFumble ? `Fumble` : `Inaccurate`) + ` — Pass skill available.`;
    }

    // No Pass skill: a failed pass may still be saved by a team reroll / Pro.
    if ((isFumble || !accurate) && !p.skills?.includes('Pass')) {
        return _offerPassReroll(G, p, targetCol, targetRow, target,
            msg + (isFumble ? 'Fumble' : 'Inaccurate') + '. ');
    }

    if (isFumble) return _doFumble(G, p, msg);
    return _continueThrow(G, p, targetCol, targetRow, accurate, msg);
}

// ── resolvePassReroll ─────────────────────────────────────────────
// Called after throwBall suspends into G.pending (kind 'passReroll').
// use=true: spend the Pass skill reroll. use=false: accept the result.

function resolvePassReroll(G, use) {
    if (G.pending?.kind !== 'passReroll') return null;
    const { targetCol, targetRow, target, msg: prevMsg, isFumble } = G.pending;
    G.pending = null;
    const p = G.activated;
    if (!p) return null;

    if (!use) {
        // Pass skill declined — a team reroll / Pro may still be used.
        return _offerPassReroll(G, p, targetCol, targetRow, target,
            prevMsg + (isFumble ? 'Fumble' : 'Inaccurate') + '. ');
    }

    G.hasPassReroll  = true;
    const reroll     = Math.floor(Math.random() * 6) + 1;
    const msg        = prevMsg + `Uses Pass skill, rerolls: ${reroll}. `;
    if (reroll === 1) return _doFumble(G, p, msg);
    const accurate   = reroll === 6 || reroll >= target;
    return _continueThrow(G, p, targetCol, targetRow, accurate, msg);
}

// ── _offerPassReroll ──────────────────────────────────────────────
// Offers a team reroll / Pro on a failed pass (after the Pass skill, or when the
// passer has no Pass skill). Pre-rolls the retry and routes through _offerReroll,
// resolving the throw via _continueThrow / _doFumble.

function _offerPassReroll(G, p, targetCol, targetRow, target, baseMsg) {
    G.passing       = false;
    const r2        = d6();
    const r2Fumble  = r2 === 1;
    const r2Acc     = !r2Fumble && (r2 === 6 || r2 >= target);
    return _offerReroll(G, p, {
        rerolled: false, label: 'pass', secondFailed: !r2Acc, baseMsg,
        successMsg: `Team reroll → accurate (rolled ${r2}). `,
        failMsg:    `Team reroll → ${r2Fumble ? 'fumble' : 'inaccurate'} (rolled ${r2}). `,
        onSuccess: (G, suffix) => _continueThrow(G, p, targetCol, targetRow, true, baseMsg + suffix),
        onFail:    (G, suffix) => r2Fumble
            ? _doFumble(G, p, baseMsg + suffix)
            : _continueThrow(G, p, targetCol, targetRow, false, baseMsg + suffix),
    });
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
// Called after throwBall suspends into G.pending (kind 'intercept').
// interceptorId: a player id (attempt interception) or null (decline).

function chooseInterceptor(G, interceptorId) {
    if (G.pending?.kind !== 'intercept') return null;
    const { declaredCol, declaredRow, actualCol, actualRow,
            accurate, scatterMsg, interceptorIds } = G.pending;
    G.pending = null;
    const p = G.activated;
    if (!p) return null;

    let msg = scatterMsg || '';

    if (interceptorId !== null) {
        const interceptor = G.players.find(pl => pl.id === interceptorId
                                              && interceptorIds.includes(pl.id));
        if (interceptor) {
            const iMod       = accurate ? 3 : 2;
            const iTzs       = countTackleZones(G, interceptor.side, interceptor.col, interceptor.row);
            const stuntyMod  = interceptor.skills?.includes('Stunty') ? 1 : 0;
            const iTarget    = Math.min(interceptor.ag + iMod + iTzs + stuntyMod, 6);
            const iRoll   = Math.floor(Math.random() * 6) + 1;
            const iHit    = iRoll === 6 || iRoll >= iTarget;
            msg += `${pn(interceptor)} [[skill:intercepts]] (${iRoll} vs ${iTarget}+): ${iHit ? 'SUCCESS!' : 'failed.'} `;
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

// ── Handoff Action ────────────────────────────────────────────────

// Declare handoff: activates the player (allowed prone, ball not required yet).
// One handoff allowed per team per turn.

function declareHandoff(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p) return null;
    const t = _traitChecks(G, p, false);
    if (t.abort) return t.msg;
    const prefix = t.msg;

    G.activated  = p;
    G.sel        = p;
    G.handingOff = true;
    if (G.animalSavagery) return prefix;
    return (prefix ? prefix + ' ' : '') + `${pn(p)} [[skill:declares Handoff]] — move to a teammate and hand off.`;
}

// Execute the handoff to an adjacent standing teammate.
// Receiver makes an AG catch roll (no throw modifier, TZs apply).

function doHandoff(G, receiverId) {
    if (!G.handingOff || !G.activated) return null;
    const p = G.activated;
    if (!p.hasBall) return null;

    const receiver = G.players.find(pl => pl.id === receiverId);
    if (!receiver || receiver.side !== p.side) return null;
    if (!isStanding(receiver)) return null;
    if (!isAdjacent(p, receiver)) return null;

    const passerSide   = p.side;
    p.hasBall          = false;
    G.ball.carrier     = null;
    G.ball.col         = receiver.col;
    G.ball.row         = receiver.row;
    G.handingOff       = false;
    G.hasHandedOff     = true;
    endActivation(G);

    const msg = `${pn(p)} [[skill:hands off]] to ${pn(receiver)}.`;
    return _checkPassTurnover(G, passerSide, msg + _catchAtSquare(G, receiver.col, receiver.row, false));
}

// ── Kickoff event table ───────────────────────────────────────────

if (typeof module !== 'undefined') {
    module.exports = { _checkPassTurnover, _resolveAccuratePass, declarePass, _ptSegDist, getInterceptors, _doFumble, _continueThrow, throwBall, resolvePassReroll, _offerPassReroll, _resolveInaccurateAtLanding, chooseInterceptor, declareHandoff, doHandoff };
}

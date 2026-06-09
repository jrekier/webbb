// move.js
// Movement: stepping & rushing, dodging (with Diving Tackle), and the
// Secure-the-Ball action.

if (typeof module !== 'undefined') {
    var { canMoveTo, isAdjacent, isStanding, sqLabel } = require('./helpers.js');
    var { dodge, rush } = require('./dice.js');
    var { activatePlayer, endActivation, endTurn } = require('./core.js');
    var { _offerReroll, _traitChecks, checkTouchdown, knockDown, pn, scatterBall, tryPickup } = require('./resolve.js');
}

function doSecureRoll(G, p) {
    const roll   = Math.floor(Math.random() * 6) + 1;
    G.securingBall = false;
    if (roll >= 2) {
        p.hasBall      = true;
        G.ball.carrier = p;
        endActivation(G);
        return `${pn(p)} [[skill:secures]] the ball (rolled ${roll}).`;
    }
    const scatterMsg = scatterBall(G);
    endTurn(G);
    return `${pn(p)} fails to secure (rolled ${roll}, needed 2+). ${scatterMsg} TURNOVER`;
}

// ── secureBall ────────────────────────────────────────────────────
// Secure the Ball action (BB2025): activates player in securing mode.
// The player moves normally and the 2+ fires when they step onto the ball square.

function secureBall(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p) return null;
    const t = _traitChecks(G, p, false);
    if (t.abort) return t.msg;
    const prefix = t.msg;

    G.activated    = p;
    G.sel          = p;
    G.securingBall = true;
    if (G.animalSavagery) return prefix;
    return (prefix ? prefix + ' ' : '') + `${pn(p)} [[skill:declares Secure Ball]] — move to the ball.`;
}

// ── Pass Action ───────────────────────────────────────────────────

// Scatter ball N times (no intermediate catch checks — used for
// the Scatter(3) on an inaccurate pass). Returns { msg, done }
// where done=true means the ball went out of bounds and was already
// resolved via throwIn (caller should return msg immediately).

// Confirmed rush or dodge failure: land the player and apply injury.
// Player must be placed at the destination square for the knockdown.
function _moveTurnover(G, p, col, row, msg) {
    p.col = col;
    p.row = row;
    msg += knockDown(G, p);
    if (!G.ball.carrier && G.ball.col === p.col && G.ball.row === p.row) msg += ' ' + scatterBall(G);
    endTurn(G);
    return msg + ' TURNOVER';
}

// Rush AND dodge (if any) succeeded — place the player and handle pickup/TD.
function _finishMove(G, p, col, row, needsrush, msg) {
    p.col = col;
    p.row = row;
    if (!needsrush) p.maLeft   -= 1;
    else            p.rushLeft -= 1;
    G.stoodUpFromProne = false;
    G.sel = p;
    // Don't auto-end if a declared action that costs no MA still needs resolving.
    if (p.maLeft + p.rushLeft === 0 && !G.passing && !G.handingOff && !G.fouling) endActivation(G);

    let pickupMsg;
    if (G.securingBall && p.col === G.ball.col && p.row === G.ball.row) {
        pickupMsg = doSecureRoll(G, p);
    } else {
        pickupMsg = tryPickup(G, p);
    }
    if (pickupMsg) {
        msg += ' ' + pickupMsg;
        // tryPickup may itself suspend into G.pending (team reroll on pickup).
        if (pickupMsg.includes('TURNOVER') || G.pending) return msg;
    }

    const tdMsg = checkTouchdown(G, p);
    if (tdMsg) return msg + ' ' + tdMsg;
    return msg;
}

// Resolves one dodge: the roll, the Dodge-skill free reroll, and a possible
// team-reroll offer. Returns the final (or suspended) message string. A
// successful dodge is handed to _dodgeSucceeded, which may offer Diving Tackle.
function _checkDodge(G, p, col, row, needsrush, dodgerolltarget, msg) {
    const markedByTackle = G.players.some(e =>
        e.side !== p.side && isStanding(e) && isAdjacent(p, e) && e.skills?.includes('Tackle'));

    let { roll, target, failed } = dodge(dodgerolltarget);
    // True once any reroll (skill or team) has been used/offered on this roll.
    let rerolled = false;

    if (!failed) {
        return _dodgeSucceeded(G, p, col, row, needsrush, roll, target,
            msg + `${pn(p)} [[move:dodges]] (rolled ${roll}, needed ${target}+). `);
    }

    if (p.skills?.includes('Dodge') && !G.hasDodged && !markedByTackle) {
        msg += `${pn(p)} fails dodge (rolled ${roll}, needed ${target}+). Uses Dodge skill. `;
        G.hasDodged = true;
        rerolled    = true;
        ({ roll, target, failed } = dodge(dodgerolltarget));
        if (!failed) {
            return _dodgeSucceeded(G, p, col, row, needsrush, roll, target,
                msg + `${pn(p)} [[move:dodges]] on reroll (rolled ${roll}, needed ${target}+). `);
        }
    }

    msg += `${pn(p)} fails dodge (rolled ${roll}, needed ${target}+). `;
    // Pre-roll the second attempt now so _resolveTeamReroll needs no dice knowledge.
    const { roll: r2, target: t2, failed: f2 } = dodge(dodgerolltarget);
    const msgAtFailure = msg;
    return _offerReroll(G, p, {
        rerolled, label: 'dodge', secondFailed: f2, baseMsg: msg,
        successMsg: `Team reroll: ${pn(p)} [[move:dodges]] (rolled ${r2}, needed ${t2}+). `,
        failMsg:    `Team reroll: ${pn(p)} fails dodge again (rolled ${r2}, needed ${t2}+). `,
        onSuccess: (G, suffix) => _dodgeSucceeded(G, p, col, row, needsrush, r2, t2, msgAtFailure + suffix),
        onFail:    (G, suffix) => _moveTurnover(G, p, col, row, msgAtFailure + suffix),
    });
}

// ── Diving Tackle ─────────────────────────────────────────────────
// After a dodge SUCCEEDS, a standing opponent marking the square being left may
// use Diving Tackle: apply a −2 modifier to the (already rolled) Agility test
// and be placed prone in the square the dodger vacated. It is reactive — only
// offered when that −2 would turn the success into a failure (never vs a natural
// 6) — and only one marker may use it.

function _divingTacklers(G, p) {
    return G.players.filter(e =>
        e.side !== p.side && isStanding(e) && !e.distracted
        && e.skills?.includes('Diving Tackle')
        && Math.abs(e.col - p.col) <= 1 && Math.abs(e.row - p.row) <= 1
        && !(e.col === p.col && e.row === p.row)
    );
}

// Called when a dodge succeeds. p still occupies its source square here, so that
// is the square being vacated. Offers Diving Tackle when a marker's −2 would
// break the dodge; otherwise finishes the move.
function _dodgeSucceeded(G, p, col, row, needsrush, roll, target, msg) {
    if (roll !== 6 && (roll - 2) < target) {
        const dts = _divingTacklers(G, p);
        if (dts.length > 0) {
            const dt = dts[0];
            G.pending = {
                kind: 'divingTackle', side: dt.side, dtId: dt.id, moverId: p.id,
                col, row, needsrush, roll, target,
                srcCol: p.col, srcRow: p.row, msg,
            };
            return msg + `${pn(dt)} may use [[skill:Diving Tackle]] on ${pn(p)} (−2 to the dodge).`;
        }
    }
    return _finishMove(G, p, col, row, needsrush, msg);
}

// ── resolveDivingTackle ───────────────────────────────────────────
// Called after a successful dodge suspends into G.pending (kind 'divingTackle').
// use=true : −2 is applied. Since it is only offered when that breaks the dodge,
//            the dodger now fails — knocked down in the destination square
//            (turnover) — and the diver is placed prone in the vacated source.
// use=false: the dodge stands and the move finishes.

function resolveDivingTackle(G, use) {
    if (G.pending?.kind !== 'divingTackle') return null;
    const { dtId, moverId, col, row, needsrush, roll, target, srcCol, srcRow, msg } = G.pending;
    G.pending = null;
    const dt = G.players.find(x => x.id === dtId);
    const p  = G.players.find(x => x.id === moverId);
    if (!p) return null;

    if (!use || !dt) return _finishMove(G, p, col, row, needsrush, msg);

    const m = msg + `${pn(dt)} uses [[skill:Diving Tackle]]! −2 to the dodge — ${pn(p)} fails (${roll}−2 < ${target}+). `;
    const turnMsg = _moveTurnover(G, p, col, row, m);

    // The diver is placed prone in the now-vacated source square.
    dt.col    = srcCol;
    dt.row    = srcRow;
    dt.status = 'prone';
    let extra = '';
    if (dt.hasBall) {
        dt.hasBall     = false;
        G.ball.carrier = null;
        G.ball.col     = srcCol;
        G.ball.row     = srcRow;
        extra = ' ' + scatterBall(G);
    }
    return turnMsg + ` ${pn(dt)} dives into ${sqLabel(srcCol, srcRow)} and is placed prone.` + extra;
}

// ── movePlayer ────────────────────────────────────────────────────
// Moves the activated player one square, handling stand-up, rush,
// dodge, ball pickup/secure, and touchdown.

function movePlayer(G, col, row) {
    if (!G.activated) return null;
    if (G.pending?.kind === 'divingTackle') return null;   // a dodge is suspended awaiting a Diving Tackle decision
    const { allowed, needsrush, dodgerolltarget } = canMoveTo(G, G.activated, col, row);
    if (!allowed) return null;

    const p = G.activated;
    let msg = '';

    // Stand up from prone — fires for passers/handoff-declarers (not for activateMover
    // players who are already active by the time they reach here).
    if (p.status === 'prone') {
        const rushesNeeded = Math.max(0, 3 - p.maLeft);
        const rolls = [];
        for (let i = 0; i < rushesNeeded; i++) {
            const { roll, failed } = rush();
            rolls.push(roll);
            if (failed) {
                let injMsg = knockDown(G, p);
                if (!G.ball.carrier && G.ball.col === p.col && G.ball.row === p.row) injMsg += ' ' + scatterBall(G);
                endTurn(G);
                return `${pn(p)} fails to stand (rolled ${rolls.join(', ')}). ${injMsg} TURNOVER`;
            }
        }
        p.rushLeft -= rushesNeeded;
        p.maLeft    = Math.max(0, p.maLeft - 3);
        p.status    = 'active';
        G.stoodUpFromProne = true;
        const rollStr = rolls.length ? ` (rushed: ${rolls.join(', ')})` : '';
        msg += `${pn(p)} [[move:stands up]]${rollStr}. `;
    }

    // Rush for regular movement
    if (needsrush) {
        const { roll: rushroll, failed: rushFailed } = rush();
        if (rushFailed) {
            msg += `${pn(p)} fails rush (rolled ${rushroll}). `;
            // True once any reroll (skill or team) has been used/offered on this roll.
            // No skill auto-rerolls rush yet, but the flag is ready for future skills (e.g. Sprint).
            // Pre-roll the second attempt now so _resolveTeamReroll needs no dice knowledge.
            const { roll: r2, failed: f2 } = rush();
            const msgBeforeReroll = msg;
            return _offerReroll(G, p, {
                rerolled: false, label: 'rush', secondFailed: f2, baseMsg: msg,
                successMsg: `Team reroll: ${pn(p)} [[move:rushes]] (rolled ${r2}). `,
                failMsg:    `Team reroll: ${pn(p)} fails rush again (rolled ${r2}). `,
                // If rush succeeds, still need to check dodge (if entering a tackle zone).
                onSuccess: (G, suffix) => {
                    const m = msgBeforeReroll + suffix;
                    if (dodgerolltarget !== 0) {
                        return _checkDodge(G, p, col, row, needsrush, dodgerolltarget, m);
                    }
                    return _finishMove(G, p, col, row, needsrush, m);
                },
                onFail: (G, suffix) => _moveTurnover(G, p, col, row, msgBeforeReroll + suffix),
            });
        }
        msg += `${pn(p)} [[move:rushes]] (rolled ${rushroll}). `;
    }

    // Dodge — _checkDodge fully resolves the roll, rerolls, an optional Diving
    // Tackle, and the move's completion, returning the final/suspended message.
    if (dodgerolltarget !== 0) {
        return _checkDodge(G, p, col, row, needsrush, dodgerolltarget, msg);
    }

    return _finishMove(G, p, col, row, needsrush, msg);
}

// ── activateMover ─────────────────────────────────────────────────
// Activates a player for a move action.
// Prone players stand up immediately: costs 3 MA with rush rolls as needed.
// Sets G.stoodUpFromProne so cancel can restore the player to prone.

function activateMover(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p) return null;

    const t = _traitChecks(G, p, false);
    if (t.abort) return t.msg;
    const prefix = t.msg;
    const preMsg  = prefix ? prefix + ' ' : '';

    if (p.status !== 'prone') {
        const r = activatePlayer(G, playerId);
        if (r == null) return null;
        if (G.animalSavagery) return prefix;
        return preMsg + r;
    }

    // Prone: need at least 3 total MA+rush to stand
    if (p.maLeft + p.rushLeft < 3) return null;

    G.hasBlocked = false;   // fresh activation — no block thrown yet
    G.activated = p;
    G.sel       = p;

    const rushesNeeded = Math.max(0, 3 - p.maLeft);
    const rolls = [];
    for (let i = 0; i < rushesNeeded; i++) {
        const { roll, failed } = rush();
        rolls.push(roll);
        if (failed) {
            let injMsg = knockDown(G, p);
            if (!G.ball.carrier && G.ball.col === p.col && G.ball.row === p.row) injMsg += ' ' + scatterBall(G);
            endTurn(G);
            return preMsg + `${pn(p)} fails to stand (rolled ${rolls.join(', ')}). ${injMsg} TURNOVER`;
        }
    }

    p.rushLeft -= rushesNeeded;
    p.maLeft    = Math.max(0, p.maLeft - 3);
    p.status    = 'active';
    G.stoodUpFromProne = true;

    const rollStr = rolls.length ? ` (rushed: ${rolls.join(', ')})` : '';
    const maStr   = p.maLeft > 0 ? ` · ${p.maLeft} MA left` : '';
    if (G.animalSavagery) return prefix;
    return preMsg + `${pn(p)} [[move:stands up]]${rollStr}${maStr}`;
}

// ── declarePV ─────────────────────────────────────────────────────
// Enters Projectile Vomit targeting mode. Works as a standalone action
// or as a blitz replacement (clears G.blitz in either case).

if (typeof module !== 'undefined') {
    module.exports = { doSecureRoll, secureBall, _moveTurnover, _finishMove, _checkDodge, _divingTacklers, _dodgeSucceeded, resolveDivingTackle, movePlayer, activateMover };
}

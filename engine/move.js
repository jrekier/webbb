// move.js
// Player movement: walking, rushing, dodging, standing up.

if (typeof module !== 'undefined') {
    var { playerAt, isAdjacent, isStanding, countTackleZones,
          activatePlayer, endTurn, endActivation } = require('./logic.js');
    var { rush, dodge }                      = require('./dice.js');
    var { scatterBall, tryPickup,
          checkTouchdown, doSecureRoll }     = require('./ball.js');
    var { knockDown }                        = require('./block.js');
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

// ── movePlayer ────────────────────────────────────────────────────
// Moves the activated player one square, handling stand-up, rush,
// dodge, ball pickup/secure, and touchdown.

function movePlayer(G, col, row) {
    if (!G.activated) return null;
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
                return `${p.name} fails to stand (rolled ${rolls.join(', ')}). ${injMsg} TURNOVER`;
            }
        }
        p.rushLeft -= rushesNeeded;
        p.maLeft    = Math.max(0, p.maLeft - 3);
        p.status    = 'active';
        G.stoodUpFromProne = true;
        const rollStr = rolls.length ? ` (rushed: ${rolls.join(', ')})` : '';
        msg += `${p.name} stands up${rollStr}. `;
    }

    // Rush for regular movement
    if (needsrush) {
        const { roll: rushroll, failed: rushFailed } = rush();
        if (rushFailed) {
            msg += `${p.name} fails rush (rolled ${rushroll}). `;
            p.col = col;
            p.row = row;
            msg += knockDown(G, p);
            if (!G.ball.carrier && G.ball.col === p.col && G.ball.row === p.row) msg += ' ' + scatterBall(G);
            endTurn(G);
            return msg;
        }
        msg += `${p.name} rushes (rolled ${rushroll}). `;
    }

    // Dodge
    if (dodgerolltarget !== 0) {
        const markedByTackle = G.players.some(enemy =>
            enemy.side !== p.side && isStanding(enemy)
            && isAdjacent(p, enemy) && enemy.skills?.includes('Tackle')
        );

        let { roll, target, failed } = dodge(dodgerolltarget);
        if (!failed) {
            msg += `${p.name} dodges (rolled ${roll}, needed ${target}+). `;
        } else {
            if (p.skills?.includes('Dodge') && !G.hasDodged && !markedByTackle) {
                msg += `${p.name} fails dodge (rolled ${roll}, needed ${target}+). Uses Dodge skill. `;
                G.hasDodged = true;
                ({ roll, target, failed } = dodge(dodgerolltarget));
                if (!failed) {
                    msg += `${p.name} succeeds dodge on reroll (rolled ${roll}, needed ${target}+). `;
                }
            }
            if (failed) {
                msg += `${p.name} fails dodge (rolled ${roll}, needed ${target}+). `;
                p.col = col;
                p.row = row;
                msg += knockDown(G, p);
                if (!G.ball.carrier && G.ball.col === p.col && G.ball.row === p.row) msg += ' ' + scatterBall(G);
                endTurn(G);
                return msg + ' TURNOVER';
            }
        }
    }

    p.col = col;
    p.row = row;
    if (!needsrush) p.maLeft   -= 1;
    else            p.rushLeft -= 1;
    G.stoodUpFromProne = false;
    G.sel = p;
    // Don't auto-end if a declared action that costs no MA still needs resolving
    // (blitz is excluded: the block costs 1 MA, so MA=0 means no block possible)
    if (p.maLeft + p.rushLeft === 0 && !G.passing && !G.handingOff && !G.fouling) endActivation(G);

    // Ball pickup / secure
    let pickupMsg;
    if (G.securingBall && p.col === G.ball.col && p.row === G.ball.row) {
        pickupMsg = doSecureRoll(G, p);
    } else {
        pickupMsg = tryPickup(G, p);
    }
    if (pickupMsg) {
        msg += ' ' + pickupMsg;
        if (pickupMsg.includes('TURNOVER')) return msg;
    }

    const tdMsg = checkTouchdown(G, p);
    if (tdMsg) return msg + ' ' + tdMsg;

    return msg;
}

// ── activateMover ─────────────────────────────────────────────────
// Activates a player for a move action.
// Prone players stand up immediately: costs 3 MA with rush rolls as needed.
// Sets G.stoodUpFromProne so cancel can restore the player to prone.

function activateMover(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p || p.side !== G.active || p.usedAction || G.activated || p.status === 'stunned') return null;

    if (p.status !== 'prone') {
        return activatePlayer(G, playerId);
    }

    // Prone: need at least 3 total MA+rush to stand
    if (p.maLeft + p.rushLeft < 3) return null;

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
            return `${p.name} fails to stand (rolled ${rolls.join(', ')}). ${injMsg} TURNOVER`;
        }
    }

    p.rushLeft -= rushesNeeded;
    p.maLeft    = Math.max(0, p.maLeft - 3);
    p.status    = 'active';
    G.stoodUpFromProne = true;

    const rollStr = rolls.length ? ` (rushed: ${rolls.join(', ')})` : '';
    const maStr   = p.maLeft > 0 ? ` · ${p.maLeft} MA left` : '';
    return `${p.name} stands up${rollStr}${maStr}`;
}

if (typeof module !== 'undefined') {
    module.exports = { canMoveTo, movePlayer, activateMover };
}

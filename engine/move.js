// move.js
// Player movement: walking, rushing, dodging, standing up.

if (typeof module !== 'undefined') {
    var { playerAt, isAdjacent, isStanding, countTackleZones,
          endTurn, endActivation }           = require('./logic.js');
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
    const minMA = player.status === 'prone' ? 3 : 1;
    const allowed = (
        dc <= 1 && dr <= 1 && !(dc === 0 && dr === 0)
        && player.maLeft + player.rushLeft >= minMA
        && playerAt(G, col, row) === null
    );

    let needsrush = (player.maLeft === 0);
    if (player.status === 'prone') needsrush = (player.maLeft < 3);

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
    let standingUp = false;

    // Stand up from prone — costs 3 MA total; rush rolls cover shortfall
    if (p.status === 'prone') {
        standingUp = true;
        const rushesNeeded = Math.max(0, 3 - p.maLeft);
        for (let i = 0; i < rushesNeeded; i++) {
            const { roll, failed } = rush();
            if (failed) {
                msg += `${p.name} fails to stand (rolled ${roll}). `;
                p.col = col;
                p.row = row;
                msg += knockDown(G, p);
                if (!G.ball.carrier) msg += ' ' + scatterBall(G);
                endTurn(G);
                return msg + ' TURNOVER';
            }
            msg += `${p.name} rushes to stand (rolled ${roll}). `;
        }
        p.rushLeft -= rushesNeeded;
        p.maLeft    = 0;
        p.status    = 'active';
    }

    // Rush for regular movement (already standing)
    if (!standingUp && needsrush) {
        const { roll: rushroll, failed: rushFailed } = rush();
        if (rushFailed) {
            msg += `${p.name} fails rush (rolled ${rushroll}). `;
            p.col = col;
            p.row = row;
            msg += knockDown(G, p);
            if (!G.ball.carrier) msg += ' ' + scatterBall(G);
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
                if (!G.ball.carrier) msg += ' ' + scatterBall(G);
                endTurn(G);
                return msg + ' TURNOVER';
            }
        }
    }

    p.col = col;
    p.row = row;
    if (!standingUp) {
        if (!needsrush) p.maLeft   -= 1;
        else            p.rushLeft -= 1;
    }
    G.sel = p;
    if (p.maLeft + p.rushLeft === 0) endActivation(G);

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

// ── standUp ──────────────────────────────────────────────────────
// Stand-up only action for prone players (no move follows).
// Costs 3 MA; rush rolls cover any shortfall.

function standUp(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p || p.side !== G.active || p.usedAction || G.activated || p.status !== 'prone') return null;

    G.activated = p;
    G.sel       = p;

    const rushesNeeded = Math.max(0, 3 - p.maLeft);

    if (rushesNeeded === 0) {
        p.maLeft -= 3;
        p.status  = 'active';
        if (p.maLeft === 0) endActivation(G);
        return `${p.name} stands up · ${p.maLeft} MA left`;
    }

    const rolls = [];
    for (let i = 0; i < rushesNeeded; i++) {
        const { roll, failed } = rush();
        rolls.push(roll);
        if (failed) {
            let injMsg = knockDown(G, p);
            if (!G.ball.carrier) injMsg += ' ' + scatterBall(G);
            endTurn(G);
            return `${p.name} fails to stand (rolled ${rolls.join(', ')}). ${injMsg} TURNOVER`;
        }
    }

    p.maLeft = 0;
    p.status  = 'active';
    endActivation(G);
    return `${p.name} stands up on a rush (rolled ${rolls.join(', ')})`;
}

if (typeof module !== 'undefined') {
    module.exports = { canMoveTo, movePlayer, standUp };
}

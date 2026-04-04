// block.js
// Blocking: assists, dice, push, follow-up, knockdown, blitz.

if (typeof module !== 'undefined') {
    var { playerAt, isAdjacent, isStanding, inTackleZoneOf,
          endTurn, endActivation } = require('./logic.js');
    var { BLOCK_FACES, rollBlockDice, rollArmourAndInjury, rollCrowdInjury } = require('./dice.js');
    var { scatterBall, throwIn } = require('./ball.js');
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

// ── knockDown ─────────────────────────────────────────────────────
// Sets a player prone, drops the ball, rolls armour + injury.
// Ball scatter is always the caller's responsibility.
// Returns a description string.

function knockDown(G, p, { attacker } = {}) {
    p.status = 'prone';
    if (p.hasBall) {
        p.hasBall      = false;
        G.ball.carrier = null;
        G.ball.col     = p.col;
        G.ball.row     = p.row;
    }

    const { armorRoll, armorBroken, injuryRoll, outcome } = rollArmourAndInjury(p, attacker);

    if (!armorBroken) {
        return `AV ${armorRoll}/${p.av} — armour holds.`;
    }
    if (outcome === 'stunned') {
        p.status = 'stunned';
        return `AV ${armorRoll}/${p.av} broken! Inj ${injuryRoll}: Stunned.`;
    }
    if (outcome === 'ko') {
        p.status = 'ko';
        p.col    = -1;
        return `AV ${armorRoll}/${p.av} broken! Inj ${injuryRoll}: KO'd!`;
    }
    p.status = 'casualty';
    p.col    = -1;
    return `AV ${armorRoll}/${p.av} broken! Inj ${injuryRoll}: CASUALTY!`;
}

// ── declareBlock ─────────────────────────────────────────────────
// Rolls block dice and sets G.block with phase 'pick-face'.

function declareBlock(G, att, def) {
    const { attStr, defStr } = countAssists(G, att, def);
    const { dice, chooser }  = blockDiceCount(attStr, defStr);
    const rolls = rollBlockDice(dice);

    G.block = {
        att, def, rolls, chooser,
        phase: 'pick-face',
        chosenFace:  null,
        pushSquares: null,
    };

    return `${att.name} (ST${attStr}) blocks ${def.name} (ST${defStr}) · ${dice}d`;
}

// ── pickBlockFace ─────────────────────────────────────────────────
// Applies the chosen face and transitions state.

function pickBlockFace(G, face) {
    const { att, def } = G.block;
    G.block.chosenFace = face;

    switch (face.id) {

        case 'ATT_DOWN': {
            let injMsg = knockDown(G, att);
            if (!G.ball.carrier && G.ball.col === att.col && G.ball.row === att.row) injMsg += ' ' + scatterBall(G);
            G.block = null;
            G.blitz = null;
            G.activated = null;
            att.usedAction = true;
            endTurn(G);
            return `${att.name} is knocked down! ${injMsg} TURNOVER`;
        }

        case 'BOTH_DOWN': {
            const attHasBlock = att.skills?.includes('Block');
            const defHasBlock = def.skills?.includes('Block');
            const attInj      = attHasBlock ? null : knockDown(G, att);
            const defInj      = defHasBlock ? null : knockDown(G, def, { attacker: att });
            const _ballAtAtt = !G.ball.carrier && G.ball.col === att.col && G.ball.row === att.row;
            const _ballAtDef = !G.ball.carrier && G.ball.col === def.col && G.ball.row === def.row;
            const scatterMsg  = (_ballAtAtt || _ballAtDef) ? ' ' + scatterBall(G) : '';
            G.block = null;
            G.blitz = null;
            att.usedAction = true;
            if (attHasBlock) {
                G.activated = null;
                if (defHasBlock) return `Both keep their footing (Block).`;
                return `${def.name} knocked down! ${defInj}${scatterMsg} ${att.name} keeps footing (Block).`;
            }
            G.activated = null;
            endTurn(G);
            if (defHasBlock) return `${att.name} knocked down! ${attInj}${scatterMsg} ${def.name} keeps footing (Block). TURNOVER`;
            return `Both knocked down! ${att.name}: ${attInj} ${def.name}: ${defInj}${scatterMsg} TURNOVER`;
        }

        case 'PUSH':
        case 'DEF_STUMBLES':
        case 'DEF_DOWN': {
            G.block.phase       = 'pick-push';
            G.block.pushSquares = getPushSquares(G, att, def);
            const falls = face.id !== 'PUSH';
            const prefix = `${def.name} is pushed back${falls ? ' and falls!' : '.'}  `;
            // If every candidate is off-pitch, auto-resolve into the crowd.
            if (G.block.pushSquares.every(([c, r]) => c < 0 || c >= COLS || r < 0 || r >= ROWS)) {
                const [cc, cr] = G.block.pushSquares[0];
                return prefix + pickPushSquare(G, cc, cr);
            }
            return prefix + 'Choose push square.';
        }
    }
}

// ── pickPushSquare ────────────────────────────────────────────────
// Moves the defender, optionally knocks them down, offers follow-up.

function pickPushSquare(G, col, row) {
    const { att, def, chosenFace } = G.block;
    const vacCol = def.col;
    const vacRow = def.row;

    // Out-of-bounds: crowd injury, then proceed to follow-up.
    const oob = col < 0 || col >= COLS || row < 0 || row >= ROWS;
    if (oob) {
        const hadBall = def.hasBall;
        if (hadBall) {
            def.hasBall    = false;
            G.ball.carrier = null;
        }
        const { injuryRoll, outcome } = rollCrowdInjury(def);
        let msg = `${def.name} pushed into the crowd! Inj ${injuryRoll}: `;
        if (outcome === 'stunned') {
            def.status = 'stunned';
            msg += `Stunned — placed in reserves.`;
        } else if (outcome === 'ko') {
            def.status = 'ko';
            msg += `KO'd!`;
        } else {
            def.status = 'casualty';
            msg += `CASUALTY!`;
        }
        def.col = -1;
        def.row = -1;
        // Ball thrown back in from the boundary (no scatter).
        if (hadBall) msg += ' ' + throwIn(G, vacCol, vacRow, col, row);
        const followUp = G.block.pendingFollowUp || { att, vacCol, vacRow };
        G.block = { phase: 'follow-up', att: followUp.att, vacCol: followUp.vacCol, vacRow: followUp.vacRow };
        return msg + ' Follow up?';
    }

    // Detect chain push victim before moving def into the square.
    const chainVictim = playerAt(G, col, row);

    def.col = col;
    def.row = row;

    let msg = `${def.name} pushed to (${col},${row}).`;

    if (
        (chosenFace.id === 'DEF_DOWN')
        || (chosenFace.id === 'DEF_STUMBLES' && !def.skills?.includes('Dodge'))
        || (chosenFace.id === 'DEF_STUMBLES' && def.skills?.includes('Dodge') && att.skills?.includes('Tackle'))
    ) {
        const injMsg = knockDown(G, def, { attacker: att });
        msg += ` ${def.name} is knocked down! ${injMsg}`;
        if (!G.ball.carrier && G.ball.col === col && G.ball.row === row) msg += ' ' + scatterBall(G);
    }

    if (chainVictim) {
        // Preserve the original follow-up data so we can restore it after all
        // chain pushes resolve. For nested chains, pendingFollowUp already holds it.
        const pendingFollowUp = G.block.pendingFollowUp || { att, vacCol, vacRow };
        // The chain direction is away from def's old square.
        const fakeAtt = { col: vacCol, row: vacRow };
        const chainSquares = getPushSquares(G, fakeAtt, chainVictim);
        G.block = {
            phase: 'pick-push',
            att: fakeAtt,
            def: chainVictim,
            chosenFace: { id: 'PUSH' },
            pushSquares: chainSquares,
            pendingFollowUp,
        };
        // If every candidate is off-pitch, auto-resolve into the crowd.
        if (chainSquares.every(([c, r]) => c < 0 || c >= COLS || r < 0 || r >= ROWS)) {
            const [cc, cr] = chainSquares[0];
            return msg + ` Chain push — ${pickPushSquare(G, cc, cr)}`;
        }
        return msg + ` Chain push — choose where ${chainVictim.name} goes.`;
    }

    const followUp = G.block.pendingFollowUp || { att, vacCol, vacRow };
    G.block = { phase: 'follow-up', att: followUp.att, vacCol: followUp.vacCol, vacRow: followUp.vacRow };
    return msg + ' Follow up?';
}

// ── resolveFollowUp ───────────────────────────────────────────────
// Commits attacker position, then scatters the ball if loose.

function resolveFollowUp(G, followUp) {
    if (!G.block || G.block.phase !== 'follow-up') return null;
    const { att, vacCol, vacRow } = G.block;

    if (followUp) {
        att.col = vacCol;
        att.row = vacRow;
    }

    G.block = null;

    if (G.blitz) {
        G.blitz = null;
        const maMsg = att.maLeft > 0 ? ` · ${att.maLeft} MA left` : '';
        if (att.maLeft === 0) {
            att.usedAction = true;
            G.activated    = null;
        }
        return (followUp ? `${att.name} follows up` : `${att.name} stays`) + maMsg;
    }

    att.usedAction = true;
    G.activated    = null;
    return followUp ? `${att.name} follows up` : `${att.name} stays`;
}

// ── activateBlitz ─────────────────────────────────────────────────
// Step 1: declare blitz. Prone blitzer stands up immediately.

function activateBlitz(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p || p.side !== G.active || p.usedAction || G.activated) return null;
    if (p.status === 'stunned') return null;
    G.activated  = p;
    G.blitz      = 'targeting';
    G.hasBlitzed = true;
    if (p.status === 'prone') {
        p.status         = 'active';
        p.maLeft         = Math.max(0, p.maLeft - 3);
        G.blitzFromProne = true;
    }
    return `${p.name} declares blitz — click a target`;
}

// ── setBlitzTarget ────────────────────────────────────────────────
// Step 2: pick the enemy to blitz.

function setBlitzTarget(G, defId) {
    const def = G.players.find(p => p.id === defId);
    if (!def || !G.activated || G.blitz !== 'targeting' || def.side === G.active) return null;
    G.blitz = { att: G.activated, def, phase: 'moving' };
    return `${G.activated.name} targets ${def.name} — move into range`;
}

// ── blitzBlock ───────────────────────────────────────────────────
// Step 3: attacker is adjacent — execute the block (costs 1 MA).

function blitzBlock(G, att, target) {
    att.maLeft = Math.max(0, att.maLeft - 1);
    return declareBlock(G, att, target);
}

if (typeof module !== 'undefined') {
    module.exports = {
        countAssists, blockDiceCount, getBlockTargets, getPushSquares,
        knockDown, declareBlock, pickBlockFace, pickPushSquare, resolveFollowUp,
        activateBlitz, setBlitzTarget, blitzBlock,
    };
}

// actions.js
// Player actions: blocking, ball mechanics, and movement.
// Merge of block.js + ball.js + move.js.
// No DOM, no canvas. Works identically in browser and Node.js.

if (typeof module !== 'undefined') {
    var { COLS, ROWS, sqLabel,
          playerAt, isAdjacent, isStanding, inTackleZoneOf, countTackleZones,
          countAssists, blockDiceCount, getBlockTargets, getPushSquares,
          isInKickerHalf, isValidKickTarget, canMoveTo,
          markStunned } = require('./helpers.js');
    var { activatePlayer, endTurn, endActivation,
          resetAfterTouchdown } = require('./core.js');
    var { rush, dodge, BLOCK_FACES, rollBlockDice,
          rollArmourAndInjury, rollInjury, rollCrowdInjury } = require('./dice.js');
}

// ── pn ────────────────────────────────────────────────────────────
// Tagged player name for rich log rendering. Side drives the color.
function pn(p) { return `[[${p.side}:${p.name.replace(/[\[\]]/g, '')}]]`; }

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
        markStunned(p);
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

// ── _boneHeadCheck / _reallyStupidCheck / _preActivate ────────────
// Pre-activation trait checks. Each returns { msg, abort } when the
// trait is present, null when absent. _preActivate combines both.

function _boneHeadCheck(G, p, causesTurnover) {
    if (!p.skills?.includes('Bone Head')) return null;
    const roll = Math.floor(Math.random() * 6) + 1;
    if (roll >= 2) {
        p.bonedHead = false;
        return { msg: `${pn(p)} [[skill:Bone Head]] (rolled ${roll}) — OK!`, abort: false };
    }
    p.bonedHead  = true;
    p.usedAction = true;
    G.activated  = null;
    G.block      = null;
    G.blitz      = null;
    G.throwTeamMate        = null;
    const base = `${pn(p)} [[skill:Bone Head]] (rolled ${roll}) — activation lost!`;
    if (causesTurnover) { endTurn(G); return { msg: base + ' TURNOVER', abort: true }; }
    return { msg: base, abort: true };
}

function _reallyStupidCheck(G, p, causesTurnover) {
    if (!p.skills?.includes('Really Stupid')) return null;
    const hasFriend = G.players.some(f =>
        f.id !== p.id && f.side === p.side && isStanding(f)
        && !f.usedAction && f.col >= 0
        && !f.skills?.includes('Bone Head') && !f.skills?.includes('Really Stupid')
        && Math.abs(f.col - p.col) <= 3 && Math.abs(f.row - p.row) <= 3
    );
    const target = hasFriend ? 2 : 4;
    const roll   = Math.floor(Math.random() * 6) + 1;
    const ctx    = hasFriend ? 'friend nearby' : 'alone';
    if (roll >= target) {
        p.reallyStupid = false;
        return { msg: `${pn(p)} [[skill:Really Stupid]] (${ctx}, rolled ${roll}/${target}+) — OK!`, abort: false };
    }
    p.reallyStupid = true;
    p.usedAction   = true;
    G.activated    = null;
    G.block        = null;
    G.blitz        = null;
    G.throwTeamMate          = null;
    const base = `${pn(p)} [[skill:Really Stupid]] (${ctx}, rolled ${roll}/${target}+) — too stupid to act!`;
    if (causesTurnover) { endTurn(G); return { msg: base + ' TURNOVER', abort: true }; }
    return { msg: base, abort: true };
}

function _animalSavageryCheck(G, p) {
    if (!p.skills?.includes('Animal Savagery')) return null;
    const roll = Math.floor(Math.random() * 6) + 1;
    if (roll >= 2) {
        return { msg: `${pn(p)} [[skill:Animal Savagery]] (rolled ${roll}) — OK!`, abort: false };
    }

    p.usedAction = true;
    G.activated  = null;
    G.block      = null;
    G.blitz      = null;
    G.throwTeamMate = null;

    const base = `${pn(p)} [[skill:Animal Savagery]] (rolled ${roll}) — goes berserk!`;
    const adjacentFriends = G.players.filter(f =>
        f.id !== p.id && f.side === p.side && isStanding(f) && f.col >= 0 && isAdjacent(p, f)
    );

    if (adjacentFriends.length === 0) {
        return { msg: base + ' No adjacent teammate — activation lost.', abort: true };
    }

    G.animalSavagery = { phase: 'pick-target', playerId: p.id };
    return { msg: base + ' Pick an adjacent teammate to attack.', abort: true };
}

function resolveASBlock(G, targetId) {
    if (!G.animalSavagery || G.animalSavagery.phase !== 'pick-target') return null;
    const p      = G.players.find(pl => pl.id === G.animalSavagery.playerId);
    const target = G.players.find(pl => pl.id === targetId);
    if (!p || !target) return null;
    if (target.id === p.id || target.side !== p.side) return null;
    if (!isStanding(target) || target.col < 0 || !isAdjacent(p, target)) return null;

    G.animalSavagery = null;

    const { dice } = blockDiceCount(p.st, target.st);
    const rolls    = rollBlockDice(dice);

    const priority = ['DEF_DOWN', 'DEF_STUMBLES', 'PUSH', 'BOTH_DOWN', 'ATT_DOWN'];
    const face = priority.reduce((best, id) => best || rolls.find(f => f.id === id), null) || rolls[0];
    const rollStr = rolls.map(f => f.label.replace('\n', ' ')).join(', ');

    let msg = `${pn(p)} attacks ${pn(target)} (${dice}d: ${rollStr} → ${face.label.replace('\n', ' ')}). `;
    let turnover = false;

    if (face.id === 'ATT_DOWN') {
        msg += knockDown(G, p);
        if (!G.ball.carrier && G.ball.col === p.col && G.ball.row === p.row) msg += ' ' + scatterBall(G);
    } else if (face.id === 'BOTH_DOWN') {
        if (!p.skills?.includes('Block')) {
            msg += knockDown(G, p) + ' ';
            if (!G.ball.carrier && G.ball.col === p.col && G.ball.row === p.row) msg += scatterBall(G) + ' ';
        }
        if (!target.skills?.includes('Block')) {
            msg += knockDown(G, target);
            if (!G.ball.carrier && G.ball.col === target.col && G.ball.row === target.row) msg += ' ' + scatterBall(G);
            turnover = true;
        }
    } else if (face.id === 'PUSH') {
        msg += `${pn(target)} pushed (no movement).`;
    } else if (face.id === 'DEF_STUMBLES') {
        if (!target.skills?.includes('Dodge')) {
            msg += knockDown(G, target);
            if (!G.ball.carrier && G.ball.col === target.col && G.ball.row === target.row) msg += ' ' + scatterBall(G);
            turnover = true;
        } else {
            msg += `${pn(target)} stumbles but uses Dodge — stays up.`;
        }
    } else if (face.id === 'DEF_DOWN') {
        msg += knockDown(G, target);
        if (!G.ball.carrier && G.ball.col === target.col && G.ball.row === target.row) msg += ' ' + scatterBall(G);
        turnover = true;
    }

    if (turnover) { endTurn(G); msg += ' TURNOVER'; }
    return msg.trimEnd();
}

function _preActivate(G, p, causesTurnover) {
    const bh = _boneHeadCheck(G, p, causesTurnover);
    if (bh?.abort) return bh;
    const rs = _reallyStupidCheck(G, p, causesTurnover);
    if (rs?.abort) return { msg: (bh ? bh.msg + ' ' : '') + rs.msg, abort: true };
    const as = _animalSavageryCheck(G, p);
    if (as?.abort) return { msg: [bh?.msg, rs?.msg, as.msg].filter(Boolean).join(' '), abort: true };
    const msg = [bh?.msg, rs?.msg, as?.msg].filter(Boolean).join(' ');
    return msg ? { msg, abort: false } : null;
}

// ── declareBlock ─────────────────────────────────────────────────
// Rolls block dice and sets G.block with phase 'pick-face'.

function declareBlock(G, att, def) {
    const pre = _preActivate(G, att, true);
    if (pre?.abort) return pre.msg;
    const preMsg = pre ? pre.msg + ' ' : '';

    const { attStr, defStr } = countAssists(G, att, def);
    const { dice, chooser }  = blockDiceCount(attStr, defStr);
    const rolls = rollBlockDice(dice);

    G.block = {
        att, def, rolls, chooser,
        phase: 'pick-face',
        chosenFace:  null,
        pushSquares: null,
    };

    return preMsg + `${pn(att)} (ST${attStr}) [[block:blocks]] ${pn(def)} (ST${defStr}) · ${dice}d`;
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
            return `${pn(att)} is knocked down! ${injMsg} TURNOVER`;
        }

        case 'BOTH_DOWN': {
            const attHasBlock = att.skills?.includes('Block');
            const defHasBlock = def.skills?.includes('Block');
            const attHadBall  = !attHasBlock && att.hasBall;
            const defHadBall  = !defHasBlock && def.hasBall;
            const attInj      = attHasBlock ? null : knockDown(G, att);
            const defInj      = defHasBlock ? null : knockDown(G, def, { attacker: att });
            const scatterMsg  = (attHadBall || defHadBall) ? ' ' + scatterBall(G) : '';
            G.block = null;
            G.blitz = null;
            att.usedAction = true;
            if (attHasBlock) {
                G.activated = null;
                if (defHasBlock) return `Both keep their footing (Block).`;
                return `${pn(def)} knocked down! ${defInj}${scatterMsg} ${pn(att)} keeps footing (Block).`;
            }
            G.activated = null;
            endTurn(G);
            if (defHasBlock) return `${pn(att)} knocked down! ${attInj}${scatterMsg} ${pn(def)} keeps footing (Block). TURNOVER`;
            return `Both knocked down! ${pn(att)}: ${attInj} ${pn(def)}: ${defInj}${scatterMsg} TURNOVER`;
        }

        case 'PUSH':
        case 'DEF_STUMBLES':
        case 'DEF_DOWN': {
            G.block.phase       = 'pick-push';
            G.block.pushSquares = getPushSquares(G, att, def);
            const falls = face.id !== 'PUSH';
            const prefix = `${pn(def)} is pushed back${falls ? ' and falls!' : '.'}  `;
            if (def.skills?.includes('Stand Firm')) {
                G.block.phase = 'stand-firm-choice';
                return prefix + `${pn(def)} may use [[skill:Stand Firm]] — stay in place?`;
            }
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
        let msg = `${pn(def)} pushed into the crowd! Inj ${injuryRoll}: `;
        if (outcome === 'stunned') {
            markStunned(def);
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

    let msg = `${pn(def)} pushed to ${sqLabel(col,row)}.`;

    let ballDropped = false;
    if (
        (chosenFace.id === 'DEF_DOWN')
        || (chosenFace.id === 'DEF_STUMBLES' && !def.skills?.includes('Dodge'))
        || (chosenFace.id === 'DEF_STUMBLES' && def.skills?.includes('Dodge') && att.skills?.includes('Tackle'))
    ) {
        ballDropped = def.hasBall;
        const injMsg = knockDown(G, def, { attacker: att });
        msg += ` ${pn(def)} is knocked down! ${injMsg}`;
    }

    if (chainVictim) {
        // Preserve the original follow-up data so we can restore it after all
        // chain pushes resolve. For nested chains, pendingFollowUp already holds it.
        const pendingFollowUp = G.block.pendingFollowUp || { att, vacCol, vacRow, ballDropped };
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
        if (chainVictim.skills?.includes('Stand Firm') && isStanding(chainVictim)) {
            G.block.phase        = 'stand-firm-choice';
            G.block.pushedPlayer = def;
            return msg + ` Chain push — ${pn(chainVictim)} may use [[skill:Stand Firm]] — stay in place?`;
        }
        // If every candidate is off-pitch, auto-resolve into the crowd.
        if (chainSquares.every(([c, r]) => c < 0 || c >= COLS || r < 0 || r >= ROWS)) {
            const [cc, cr] = chainSquares[0];
            return msg + ` Chain push — ${pickPushSquare(G, cc, cr)}`;
        }
        return msg + ` Chain push — choose where ${chainVictim.name} goes.`;
    }

    const followUp = G.block.pendingFollowUp || { att, vacCol, vacRow, ballDropped };
    G.block = { phase: 'follow-up', att: followUp.att, vacCol: followUp.vacCol, vacRow: followUp.vacRow, ballDropped: followUp.ballDropped };
    return msg + ' Follow up?';
}

// ── resolveFollowUp ───────────────────────────────────────────────
// Commits attacker position, then scatters the ball if loose.

function resolveFollowUp(G, followUp) {
    if (!G.block || G.block.phase !== 'follow-up') return null;
    const { att, vacCol, vacRow, ballDropped } = G.block;

    if (followUp) {
        att.col = vacCol;
        att.row = vacRow;
    }

    G.block = null;

    const scatterMsg = ballDropped ? ' ' + scatterBall(G) : '';

    if (G.blitz) {
        G.blitz = null;
        const maMsg = att.maLeft > 0 ? ` · ${att.maLeft} MA left` : '';
        if (att.maLeft === 0) {
            att.usedAction = true;
            G.activated    = null;
        }
        return (followUp ? `${pn(att)} follows up` : `${pn(att)} stays`) + maMsg + scatterMsg;
    }

    att.usedAction = true;
    G.activated    = null;
    return (followUp ? `${pn(att)} follows up` : `${pn(att)} stays`) + scatterMsg;
}

// ── resolveStandFirm ──────────────────────────────────────────────
// Called after a PUSH/DEF_STUMBLES/DEF_DOWN result suspends into
// G.block.phase='stand-firm-choice'.
// use=true : defender stays in place, no push, no follow-up.
// use=false: proceed to normal push resolution.

function resolveStandFirm(G, use) {
    if (!G.block || G.block.phase !== 'stand-firm-choice') return null;
    const { att, def, chosenFace, pushSquares, pendingFollowUp, pushedPlayer } = G.block;

    if (!use) {
        G.block.phase = 'pick-push';
        if (pushSquares.every(([c, r]) => c < 0 || c >= COLS || r < 0 || r >= ROWS)) {
            const [cc, cr] = pushSquares[0];
            return pickPushSquare(G, cc, cr);
        }
        return 'Choose push square.';
    }

    // Defender stays — determine whether they still fall (push is prevented, knockdown is not).
    // For chain pushes chosenFace is always PUSH so falls is always false.
    const falls =
        chosenFace.id === 'DEF_DOWN'
        || (chosenFace.id === 'DEF_STUMBLES' && !def.skills?.includes('Dodge'))
        || (chosenFace.id === 'DEF_STUMBLES' && def.skills?.includes('Dodge') && att.skills?.includes('Tackle'));

    let msg = `${pn(def)} uses [[skill:Stand Firm]] — stays in place!`;
    if (falls) {
        const injMsg = knockDown(G, def, { attacker: att });
        msg += ` ${pn(def)} is knocked down! ${injMsg}`;
        if (!G.ball.carrier && G.ball.col === def.col && G.ball.row === def.row)
            msg += ' ' + scatterBall(G);
    }

    // Chain push: restore the pushed player to their pre-push square (att = fakeAtt = vacated square).
    // Neither player moves — no follow-up.
    if (pendingFollowUp) {
        if (pushedPlayer) { pushedPlayer.col = att.col; pushedPlayer.row = att.row; }
        const realAtt    = pendingFollowUp.att;
        const scatterMsg = pendingFollowUp.ballDropped ? ' ' + scatterBall(G) : '';
        msg += ` Neither player moves.${scatterMsg}`;
        G.block = null;
        if (G.blitz) {
            G.blitz = null;
            const maMsg = realAtt.maLeft > 0 ? ` · ${realAtt.maLeft} MA left` : '';
            if (realAtt.maLeft === 0) { realAtt.usedAction = true; G.activated = null; }
            return msg + maMsg;
        }
        realAtt.usedAction = true;
        G.activated = null;
        return msg;
    }

    // Direct push: defender didn't vacate so no follow-up is possible.
    G.block = null;
    if (G.blitz) {
        G.blitz = null;
        const maMsg = att.maLeft > 0 ? ` · ${att.maLeft} MA left` : '';
        if (att.maLeft === 0) { att.usedAction = true; G.activated = null; }
        return msg + maMsg;
    }
    att.usedAction = true;
    G.activated    = null;
    return msg;
}

// ── declareFoul / executeFoul / resolveArgueCall ──────────────────
// Foul action: standing player moves adjacent to a prone/stunned enemy
// and kicks them. Armor checked with 2d6 + assists − TZs.
// Doubles on armor OR injury dice → ref spots it → Argue the Call.
// Argue: roll 1d6 — 6 cancels ejection; 1-5 upholds it and ejects the coach
// (that team can never argue again this game). One foul per team per turn.

function declareFoul(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p) return null;
    const pre = _preActivate(G, p, false);
    if (pre?.abort) return pre.msg;
    const preMsg = pre ? pre.msg + ' ' : '';
    G.activated = p;
    G.sel       = p;
    G.fouling   = true;
    return preMsg + `${pn(p)} [[foul:declares Foul]] — move adjacent to a prone/stunned enemy.`;
}

function executeFoul(G, targetId) {
    if (!G.fouling || !G.activated) return null;
    const att = G.activated;
    const def = G.players.find(p => p.id === targetId);
    if (!def || def.side === att.side) return null;
    if (!isAdjacent(att, def)) return null;
    if (def.status !== 'prone' && def.status !== 'stunned') return null;

    const { attAssists: attAssists, defAssists: defAssists } = countAssists(G, att, def);

    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    const roll = d1 + d2 + attAssists - defAssists;
    let spotted = d1 === d2;  // ref may also spot doubles on the injury roll below

    let modFoul = '';
    if (attAssists) modFoul += `+${attAssists}`;
    if (defAssists)     modFoul += `-${defAssists}`;
    let msg = `${pn(att)} [[foul:fouls]] ${pn(def)}! ${d1}+${d2}${modFoul} = ${roll} vs AV${def.av}. `;

    const defCol = def.col, defRow = def.row;

    if (roll > def.av) {
        const { d1: di1, d2: di2, injuryRoll, outcome } = rollInjury(def);
        if (di1 === di2) spotted = true;
        msg += `AV broken! Inj ${injuryRoll}: `;
        if (outcome === 'stunned') {
            markStunned(def);
            msg += 'Stunned.';
        } else if (outcome === 'ko') {
            def.status = 'ko'; def.col = -1; def.row = -1;
            msg += "KO'd!";
        } else {
            def.status = 'casualty'; def.col = -1; def.row = -1;
            msg += 'CASUALTY!';
        }
        if (!G.ball.carrier && G.ball.col === defCol && G.ball.row === defRow) {
            G.ball.col = defCol; G.ball.row = defRow;
            msg += ' ' + scatterBall(G);
        }
    } else {
        msg += 'AV holds.';
    }

    G.fouling   = false;
    G.hasFouled = true;
    endActivation(G);

    if (spotted) {
        msg += ' Ref spots the foul!';
        if (G.coachEjected[att.side]) {
            // Coach already gone — eject immediately, no argue
            att.status = 'casualty'; att.col = -1; att.row = -1;
            endTurn(G);
            return msg + ` ${pn(att)} ejected (coach already sent off). TURNOVER`;
        }
        G.argueCallPending = { attId: att.id, side: att.side };
        return msg + ' Argue the call?';
    }

    return msg;
}

// ── resolveArgueCall ──────────────────────────────────────────────
// Called after executeFoul suspends into G.argueCallPending.
// use=true: roll 1d6 — 6 cancels ejection, 1-5 upholds it and ejects the coach.
// use=false: accept the ejection without risking the coach.

function resolveArgueCall(G, use) {
    if (!G.argueCallPending) return null;
    const { attId, side } = G.argueCallPending;
    G.argueCallPending = null;
    const att = G.players.find(p => p.id === attId);
    if (!att) return null;

    if (use) {
        const roll = Math.floor(Math.random() * 6) + 1;
        if (roll === 6) {
            return `Argue the call — rolled ${roll}: ejection overruled! ${pn(att)} stays on the pitch.`;
        }
        // Upheld — coach ejected too
        G.coachEjected[side] = true;
        att.status = 'casualty'; att.col = -1; att.row = -1;
        endTurn(G);
        return `Argue the call — rolled ${roll}: upheld! ${pn(att)} ejected! ${side.toUpperCase()} coach sent off for the rest of the game. TURNOVER`;
    }

    // Accept the call
    att.status = 'casualty'; att.col = -1; att.row = -1;
    endTurn(G);
    return `${pn(att)} ejected. TURNOVER`;
}

// ── activateBlitz ─────────────────────────────────────────────────
// Step 1: declare blitz. Prone blitzer stands up immediately.

function activateBlitz(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p) return null;
    G.hasBlitzed = true;
    const pre = _preActivate(G, p, true);
    if (pre?.abort) return pre.msg;
    const preMsg = pre ? pre.msg + ' ' : '';

    G.activated  = p;
    G.blitz      = 'targeting';
    if (p.status === 'prone') {
        p.status         = 'active';
        p.maLeft         = Math.max(0, p.maLeft - 3);
        G.blitzFromProne = true;
    }
    return preMsg + `${pn(p)} [[block:declares blitz]] — click a target`;
}

// ── setBlitzTarget ────────────────────────────────────────────────
// Step 2: pick the enemy to blitz.

function setBlitzTarget(G, defId) {
    const def = G.players.find(p => p.id === defId);
    if (!def || !G.activated || G.blitz !== 'targeting' || def.side === G.active) return null;
    G.blitz = { att: G.activated, def, phase: 'moving' };
    return `${pn(G.activated)} [[block:targets]] ${pn(def)} — move into range`;
}

// ── blitzBlock ───────────────────────────────────────────────────
// Step 3: attacker is adjacent — execute the block (costs 1 MA).

function blitzBlock(G, att, target) {
    att.maLeft = Math.max(0, att.maLeft - 1);
    return declareBlock(G, att, target);
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
    const msg = `Throw-in: ${dirLabel}, ${dist} sq → ${sqLabel(tc,tr)}.`;

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
    if (!isStanding(lander)) return msg + ` Bounces off ${pn(lander)}. ` + scatterBall(G);

    const tzs    = countTackleZones(G, lander.side, tc, tr);
    const target = Math.min(lander.ag + tzs, 6);
    const roll   = Math.floor(Math.random() * 6) + 1;
    if (roll >= target || roll === 6) {
        lander.hasBall = true;
        G.ball.carrier = lander;
        return msg + ` ${pn(lander)} catches it! (${roll} vs ${target}+)`;
    }
    return msg + ` ${pn(lander)} fails to catch (${roll} vs ${target}+). ` + scatterBall(G);
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
    if (!lander) return `Ball scattered to ${sqLabel(nc,nr)}.`;

    if (!isStanding(lander)) {
        return `Ball bounces off ${pn(lander)}. ` + scatterBall(G);
    }

    const tzs    = countTackleZones(G, lander.side, nc, nr);
    const target = Math.min(lander.ag + tzs, 6);
    const roll   = Math.floor(Math.random() * 6) + 1;
    if (roll >= target || roll === 6) {
        lander.hasBall = true;
        G.ball.carrier = lander;
        return `Ball scattered to ${sqLabel(nc,nr)} — ${pn(lander)} catches it! (rolled ${roll}, needed ${target}+)`;
    }
    return `${pn(lander)} fails to catch (rolled ${roll}, needed ${target}+). ` + scatterBall(G);
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
        return `${pn(p)} [[skill:picks up]] the ball (rolled ${roll}, needed ${target}+).${extra}`;
    }
    const scatterMsg = scatterBall(G);
    endTurn(G);
    return `${pn(p)} fails to pick up (rolled ${roll}, needed ${target}+).${extra} ${scatterMsg} TURNOVER`;
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

    G.activated    = p;
    G.sel          = p;
    G.securingBall = true;
    return `${pn(p)} [[skill:declares Secure Ball]] — move to the ball.`;
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
        msg += `${sqLabel(nc,nr)} `;
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
    if (!isStanding(lander)) return ` ${pn(lander)} is prone. ` + scatterBall(G);

    const tzs    = countTackleZones(G, lander.side, col, row);
    const target = Math.min(lander.ag + (bouncePenalty ? 1 : 0) + tzs, 6);
    const roll   = Math.floor(Math.random() * 6) + 1;
    let extra    = '';
    let result   = roll;

    if (roll !== 6 && roll < target && lander.skills?.includes('Catch')) {
        const reroll = Math.floor(Math.random() * 6) + 1;
        extra  = ` Uses Catch skill: ${roll} → ${reroll}.`;
        result = reroll;
    }

    if (result >= target || result === 6) {
        lander.hasBall = true;
        G.ball.carrier = lander;
        const tdMsg    = checkTouchdown(G, lander);
        const catchMsg = `${pn(lander)} catches it! (${result} vs ${target}+)${extra}`;
        return tdMsg ? ` ${catchMsg} ${tdMsg}` : ` ${catchMsg}`;
    }
    return ` ${pn(lander)} fails to catch (${result} vs ${target}+).${extra} ` + scatterBall(G);
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
    const pre = _preActivate(G, p, false);
    if (pre?.abort) return pre.msg;
    const preMsg = pre ? pre.msg + ' ' : '';

    G.activated     = p;
    G.sel           = p;
    G.passing       = true;
    G.hasPassReroll = false;
    return preMsg + `${pn(p)} [[skill:declares Pass]] — move to the ball if needed, then press Throw.`;
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
    const pre = _preActivate(G, p, false);
    if (pre?.abort) return pre.msg;
    const preMsg = pre ? pre.msg + ' ' : '';

    G.activated  = p;
    G.sel        = p;
    G.handingOff = true;
    return preMsg + `${pn(p)} [[skill:declares Handoff]] — move to a teammate and hand off.`;
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

// ── Kick mechanics ────────────────────────────────────────────────

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

    let msg = `Kick aimed ${sqLabel(col,row)}: ${d6a}+${d6b} → ${dist} sq ${DIRS[dir]}.`;

    const outOfBounds  = nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS;
    const inKickerHalf = !outOfBounds && isInKickerHalf(G.kicker, nr);

    if (outOfBounds || inKickerHalf) {
        G.ball  = { col: -1, row: -1, carrier: null };
        G.phase = 'touchback';
        return msg + ` Ball out of play — TOUCHBACK! ${G.receiver.toUpperCase()} picks a player.`;
    }

    G.ball = { col: nc, row: nr, carrier: null };
    msg   += ` Lands at ${sqLabel(nc,nr)}.`;

    const lander = playerAt(G, nc, nr);
    if (lander && isStanding(lander)) {
        const tzs    = countTackleZones(G, lander.side, nc, nr);
        const target = Math.min(lander.ag + tzs, 6);
        const roll   = Math.floor(Math.random() * 6) + 1;
        if (roll >= target || roll === 6) {
            lander.hasBall = true;
            G.ball.carrier = lander;
            msg += ` ${pn(lander)} catches the kick! (${roll} vs ${target}+)`;
        } else {
            msg += ` ${pn(lander)} fails to catch (${roll} vs ${target}+). ` + scatterBall(G);
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
    return `${pn(p)} receives the touchback.`;
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
            p.col = col;
            p.row = row;
            msg += knockDown(G, p);
            if (!G.ball.carrier && G.ball.col === p.col && G.ball.row === p.row) msg += ' ' + scatterBall(G);
            endTurn(G);
            return msg;
        }
        msg += `${pn(p)} [[move:rushes]] (rolled ${rushroll}). `;
    }

    // Dodge
    if (dodgerolltarget !== 0) {
        const markedByTackle = G.players.some(enemy =>
            enemy.side !== p.side && isStanding(enemy)
            && isAdjacent(p, enemy) && enemy.skills?.includes('Tackle')
        );

        let { roll, target, failed } = dodge(dodgerolltarget);
        if (!failed) {
            msg += `${pn(p)} [[move:dodges]] (rolled ${roll}, needed ${target}+). `;
        } else {
            if (p.skills?.includes('Dodge') && !G.hasDodged && !markedByTackle) {
                msg += `${pn(p)} fails dodge (rolled ${roll}, needed ${target}+). Uses Dodge skill. `;
                G.hasDodged = true;
                ({ roll, target, failed } = dodge(dodgerolltarget));
                if (!failed) {
                    msg += `${pn(p)} [[move:dodges]] on reroll (rolled ${roll}, needed ${target}+). `;
                }
            }
            if (failed) {
                msg += `${pn(p)} fails dodge (rolled ${roll}, needed ${target}+). `;
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
    if (!p) return null;

    const pre = _preActivate(G, p, false);
    if (pre?.abort) return pre.msg;
    const preMsg = pre ? pre.msg + ' ' : '';

    if (p.status !== 'prone') {
        const r = activatePlayer(G, playerId);
        return r != null ? preMsg + r : null;
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
            return preMsg + `${pn(p)} fails to stand (rolled ${rolls.join(', ')}). ${injMsg} TURNOVER`;
        }
    }

    p.rushLeft -= rushesNeeded;
    p.maLeft    = Math.max(0, p.maLeft - 3);
    p.status    = 'active';
    G.stoodUpFromProne = true;

    const rollStr = rolls.length ? ` (rushed: ${rolls.join(', ')})` : '';
    const maStr   = p.maLeft > 0 ? ` · ${p.maLeft} MA left` : '';
    return preMsg + `${pn(p)} [[move:stands up]]${rollStr}${maStr}`;
}

// ── declarePV ─────────────────────────────────────────────────────
// Enters Projectile Vomit targeting mode. Works as a standalone action
// or as a blitz replacement (clears G.blitz in either case).

function declarePV(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p) return null;
    G.activated   = p;
    G.sel         = p;
    G.blitz       = null;
    G.pvTargeting = true;
    return `${pn(p)} [[skill:Projectile Vomit]] — select an adjacent standing enemy.`;
}

// ── executePV ─────────────────────────────────────────────────────
// Resolves a Projectile Vomit action.
// Roll d6: 2+ = unmodified armour roll on target; 1 = on self.
// Neither roll can be modified (attacker = null → no Mighty Blow etc.).

function executePV(G, targetId) {
    if (!G.pvTargeting || !G.activated) return null;
    const att = G.activated;
    const def = G.players.find(p => p.id === targetId);
    if (!def || def.side === att.side || !isAdjacent(att, def) || !isStanding(def)) return null;

    const roll     = Math.floor(Math.random() * 6) + 1;
    G.pvTargeting  = false;
    att.usedAction = true;
    G.activated    = null;

    const victim = roll >= 2 ? def : att;
    let msg = roll >= 2
        ? `${pn(att)} [[skill:Projectile Vomit]] (${roll}) → ${pn(def)}! `
        : `${pn(att)} [[skill:Projectile Vomit]] (${roll}) — self-splattered! `;

    const { armorRoll, armorBroken, injuryRoll, outcome } = rollArmourAndInjury(victim, null);
    if (!armorBroken) return msg + `AV ${armorRoll}/${victim.av} — armour holds.`;

    const hadBall = victim.hasBall;
    if (hadBall) {
        victim.hasBall = false;
        G.ball.carrier = null;
        G.ball.col     = victim.col;
        G.ball.row     = victim.row;
    }

    msg += `AV ${armorRoll}/${victim.av} broken! Inj ${injuryRoll}: `;
    if (outcome === 'stunned') {
        victim.status = 'prone';
        markStunned(victim);
        msg += 'Stunned.';
    } else if (outcome === 'ko') {
        victim.status = 'ko';
        victim.col    = -1;
        msg += "KO'd!";
    } else {
        victim.status = 'casualty';
        victim.col    = -1;
        msg += 'CASUALTY!';
    }
    if (hadBall) msg += ' ' + scatterBall(G);
    return msg;
}

// ── Throw Team-Mate ────────────────────────────────────────────────

// ── declareTTM ─────────────────────────────────────────────────────
// Activates the thrower in TTM pick-missile mode.
// Bone Head check applies before anything else.

function declareTTM(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p) return null;
    const pre = _preActivate(G, p, false);
    if (pre?.abort) return pre.msg;
    const preMsg = pre ? pre.msg + ' ' : '';

    G.activated = p;
    G.sel       = p;
    G.throwTeamMate       = { phase: 'pick-missile' };
    return preMsg + `${pn(p)} [[skill:declares Throw Team-Mate]] — pick an adjacent teammate with Right Stuff.`;
}

// ── pickTTMMissile ──────────────────────────────────────────────────
// Locks in the player to be thrown and enters targeting phase.

function pickTTMMissile(G, missileId) {
    if (!G.throwTeamMate || G.throwTeamMate.phase !== 'pick-missile') return null;
    if (!G.activated) return null;
    const p       = G.activated;
    const missile = G.players.find(pl => pl.id === missileId);
    if (!missile) return null;
    if (missile.side !== p.side) return null;
    if (missile.id === p.id) return null;
    if (!missile.skills?.includes('Right Stuff')) return null;
    if (!isStanding(missile)) return null;
    if (!isAdjacent(p, missile)) return null;

    G.throwTeamMate = { phase: 'targeting', missileId };
    return `${pn(p)} picks up ${pn(missile)} — click target square to throw.`;
}

// ── _ttmScatterNTimes ───────────────────────────────────────────────
// Scatters missile n times from (col, row).
// Returns { col, row, msg, offPitch }.

function _ttmScatterNTimes(col, row, n) {
    const DC   = [ 0, 1, 1, 1, 0,-1,-1,-1];
    const DR   = [-1,-1, 0, 1, 1, 1, 0,-1];
    const DIRS = ['N','NE','E','SE','S','SW','W','NW'];
    let sc = col, sr = row;
    const parts = [];
    for (let i = 0; i < n; i++) {
        const dir = Math.floor(Math.random() * 8);
        const nc = sc + DC[dir];
        const nr = sr + DR[dir];
        parts.push(DIRS[dir]);
        if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) {
            return { col: nc, row: nr, fromCol: sc, fromRow: sr, msg: parts.join('·'), offPitch: true };
        }
        sc = nc;
        sr = nr;
    }
    return { col: sc, row: sr, fromCol: sc, fromRow: sr, msg: parts.join('·'), offPitch: false };
}

// ── _landMissile ────────────────────────────────────────────────────
// Places missile at (col, row) and resolves landing.
// landMod: 0 for Superb, 1 for Subpar or Fumble.
// Off-pitch always causes a TURNOVER. Failed landing on-pitch does not.

function _landMissile(G, missile, col, row, msg, landMod, fromCol, fromRow) {
    const DC   = [ 0, 1, 1, 1, 0,-1,-1,-1];
    const DR   = [-1,-1, 0, 1, 1, 1, 0,-1];
    const DIRS = ['N','NE','E','SE','S','SW','W','NW'];

    const hadBall = !!missile.hasBall;
    if (hadBall) {
        missile.hasBall = false;
        G.ball.carrier  = null;
    }

    // Off-pitch landing — crowd injury + throw-in (if ball) + TURNOVER
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) {
        msg += `${pn(missile)} lands in the crowd! `;
        const injMsg = rollCrowdInjury(missile);
        missile.col = -1;
        missile.row = -1;
        if (hadBall) {
            G.ball.col = fromCol;
            G.ball.row = fromRow;
            msg += throwIn(G, fromCol, fromRow, col, row) + ' ';
        }
        endTurn(G);
        return msg + injMsg + ' TURNOVER';
    }

    // Crash landing: target square is occupied
    const occupant = G.players.find(p => p.col === col && p.row === row
                                       && p.id !== missile.id && p.col >= 0);
    if (occupant) {
        msg += `${pn(missile)} crash-lands on ${pn(occupant)}! `;
        const oHadBall = occupant.hasBall;
        if (oHadBall) {
            occupant.hasBall = false;
            G.ball.carrier   = null;
            G.ball.col       = occupant.col;
            G.ball.row       = occupant.row;
        }
        occupant.status = 'prone';
        const { armorRoll: oAV, armorBroken: oBroken,
                injuryRoll: oInj, outcome: oOut } = rollArmourAndInjury(occupant, null);
        msg += `${pn(occupant)} knocked down (AV${oAV}/${occupant.av}`;
        if (oBroken) {
            msg += ` broken! Inj${oInj}: `;
            if (oOut === 'stunned') { markStunned(occupant); msg += 'Stunned'; }
            else if (oOut === 'ko') { occupant.status = 'ko'; occupant.col = -1; msg += "KO'd"; }
            else                   { occupant.status = 'casualty'; occupant.col = -1; msg += 'Casualty'; }
        } else { msg += ' holds'; }
        msg += '). ';
        if (oHadBall && !G.ball.carrier) msg += scatterBall(G) + ' ';

        // Missile bounces ×1 from crash square
        const bounceDir = Math.floor(Math.random() * 8);
        const bc = col + DC[bounceDir];
        const br = row + DR[bounceDir];
        msg += `${pn(missile)} bounces ${DIRS[bounceDir]}. `;

        if (bc < 0 || bc >= COLS || br < 0 || br >= ROWS) {
            missile.col    = -1;
            missile.row    = -1;
            missile.status = 'prone';
            const injMsg = rollCrowdInjury(missile);
            if (hadBall) {
                G.ball.col = col;
                G.ball.row = row;
                msg += throwIn(G, col, row, bc, br) + ' ';
            }
            endTurn(G);
            return msg + `Into the crowd! ${injMsg} TURNOVER`;
        }

        // Second crash: knock down occ2, missile falls over
        const occ2 = G.players.find(p => p.col === bc && p.row === br
                                       && p.id !== missile.id && p.col >= 0);
        if (occ2) {
            const o2HadBall = occ2.hasBall;
            if (o2HadBall) {
                occ2.hasBall   = false;
                G.ball.carrier = null;
                G.ball.col     = bc;
                G.ball.row     = br;
            }
            occ2.status = 'prone';
            const inj2 = rollArmourAndInjury(occ2, null);
            msg += `Also hits ${pn(occ2)}! `;
            if (inj2.armorBroken) {
                if (inj2.outcome === 'stunned') { markStunned(occ2); }
                else if (inj2.outcome === 'ko') { occ2.status = 'ko'; occ2.col = -1; }
                else                           { occ2.status = 'casualty'; occ2.col = -1; }
            }
            if (o2HadBall && !G.ball.carrier) msg += scatterBall(G) + ' ';
        }

        // Missile falls over at bounce destination
        missile.col    = bc;
        missile.row    = br;
        missile.status = 'prone';
        const { armorRoll: mAV, armorBroken: mBroken,
                injuryRoll: mInj, outcome: mOut } = rollArmourAndInjury(missile, null);
        msg += `${pn(missile)} falls over (AV${mAV}/${missile.av}`;
        if (mBroken) {
            msg += ` broken! Inj${mInj}: `;
            if (mOut === 'stunned') { markStunned(missile); msg += 'Stunned'; }
            else if (mOut === 'ko') { missile.status = 'ko'; missile.col = -1; msg += "KO'd"; }
            else                   { missile.status = 'casualty'; missile.col = -1; msg += 'Casualty'; }
        } else { msg += ' holds'; }
        msg += '). ';

        if (hadBall) {
            const fallCol = missile.col >= 0 ? missile.col : bc;
            const fallRow = missile.row >= 0 ? missile.row : br;
            G.ball.col     = fallCol;
            G.ball.row     = fallRow;
            G.ball.carrier = null;
            msg += scatterBall(G);
            endTurn(G);
            return msg + ' TURNOVER';
        }
        return msg.trimEnd();
    }

    // Empty square: landing roll
    missile.col    = col;
    missile.row    = row;
    missile.status = 'active';

    const tzs    = countTackleZones(G, missile.side, col, row);
    const target = Math.min(missile.ag + landMod + tzs, 6);
    const roll   = Math.floor(Math.random() * 6) + 1;
    const success = roll !== 1 && (roll === 6 || roll >= target);

    const modStr = (landMod + tzs) > 0 ? ` +${landMod + tzs} mods,` : '';
    msg += `${pn(missile)} landing (AG${missile.ag}+,${modStr} → ${target}+): rolled ${roll}. `;

    if (success) {
        if (hadBall) {
            missile.hasBall = true;
            G.ball.carrier  = missile;
            G.ball.col      = col;
            G.ball.row      = row;
            const tdMsg = checkTouchdown(G, missile);
            if (tdMsg) return msg + 'Lands safely! ' + tdMsg;
        }
        return msg + 'Lands safely!';
    }

    // Failed landing — TURNOVER only if ball carried
    msg += 'Failed landing. ';
    missile.status = 'prone';
    const { armorRoll, armorBroken, injuryRoll, outcome } = rollArmourAndInjury(missile, null);
    msg += `AV${armorRoll}/${missile.av}`;
    let failMsg;
    if (!armorBroken) {
        failMsg = ' — armour holds.';
    } else {
        msg += ` broken! Inj${injuryRoll}: `;
        if (outcome === 'stunned') { markStunned(missile); failMsg = 'Stunned.'; }
        else if (outcome === 'ko') { missile.status = 'ko'; missile.col = -1; failMsg = "KO'd!"; }
        else { missile.status = 'casualty'; missile.col = -1; failMsg = 'CASUALTY!'; }
    }
    if (hadBall) {
        G.ball.col     = col;
        G.ball.row     = row;
        G.ball.carrier = null;
        const scMsg = scatterBall(G);
        endTurn(G);
        return msg + failMsg + ' ' + scMsg + ' TURNOVER';
    }
    return msg + failMsg;
}

// ── throwTeamMate ────────────────────────────────────────────────────
// Resolves the throw and landing after a target square is chosen.
// Superb: scatter ×3 from target, landing roll (no penalty).
// Subpar: scatter ×3 from target, landing roll (-1 modifier).
// Fumble: bounce ×1 from thrower's square, landing roll (-1 modifier).

function throwTeamMate(G, targetCol, targetRow) {
    if (!G.throwTeamMate || G.throwTeamMate.phase !== 'targeting') return null;
    if (!G.activated) return null;
    const p       = G.activated;
    const missile = G.players.find(pl => pl.id === G.throwTeamMate.missileId);
    if (!missile) return null;
    if (targetCol < 0 || targetCol >= COLS || targetRow < 0 || targetRow >= ROWS) return null;

    const dx   = Math.abs(p.col - targetCol);
    const dy   = Math.abs(p.row - targetRow);
    const dist = Math.floor(Math.sqrt(dx * dx + dy * dy));
    if (dist === 0 || dist > 6) return null;
    const range = dist <= 3 ? { label: 'Quick', mod: 0 } : { label: 'Short', mod: 1 };

    const tzs           = countTackleZones(G, p.side, p.col, p.row);
    const mods          = range.mod + tzs;
    const rawRoll       = Math.floor(Math.random() * 6) + 1;
    const effectiveRoll = rawRoll - mods;
    const isFumble      = rawRoll === 1 || effectiveRoll <= 1;
    const isSuperb      = !isFumble && (rawRoll === 6 || rawRoll >= p.pa + mods);

    const effStr = mods > 0 ? ` → eff. ${effectiveRoll}` : '';
    let msg = `${pn(p)} [[skill:Throw Team-Mate]] ${pn(missile)} (${range.label}, PA${p.pa}+${mods > 0 ? ` +${mods}` : ''}): rolled ${rawRoll}${effStr}. `;

    G.throwTeamMate           = null;
    G.hasThrownMate = true;
    const throwerCol = p.col;
    const throwerRow = p.row;
    endActivation(G);

    if (isFumble) {
        msg += 'FUMBLE! ';
        const { col: bc, row: br, fromCol: fc, fromRow: fr, msg: bMsg, offPitch } = _ttmScatterNTimes(throwerCol, throwerRow, 1);
        msg += `${pn(missile)} bounces ${bMsg}${offPitch ? ' (off pitch)' : ' to ' + sqLabel(bc, br)}. `;
        return _landMissile(G, missile, bc, br, msg, 1, fc, fr);
    }

    const throwLabel = isSuperb ? 'Superb' : 'Subpar';
    const { col: lc, row: lr, fromCol: fc, fromRow: fr, msg: scMsg, offPitch } = _ttmScatterNTimes(targetCol, targetRow, 3);
    msg += `${throwLabel}! Scatter ×3: ${scMsg}${offPitch ? ' (off pitch)' : ` → ${sqLabel(lc, lr)}`}. `;
    return _landMissile(G, missile, lc, lr, msg, isSuperb ? 0 : 1, fc, fr);
}

if (typeof module !== 'undefined') {
    module.exports = {
        knockDown, declareBlock, pickBlockFace, pickPushSquare, resolveFollowUp, resolveStandFirm,
        activateBlitz, setBlitzTarget, blitzBlock,
        declareFoul, executeFoul, resolveArgueCall,
        scatterBall, throwIn, tryPickup, checkTouchdown,
        doSecureRoll, secureBall,
        declarePass, throwBall, resolvePassReroll, getInterceptors, chooseInterceptor,
        declareHandoff, doHandoff,
        declareKick, touchbackGiveBall,
        movePlayer, activateMover,
        declarePV, executePV,
        declareTTM, pickTTMMissile, throwTeamMate,
        resolveASBlock,
    };
}

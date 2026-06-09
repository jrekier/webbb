// block.js
// Block resolution: block dice, push & follow-up, the reaction skills (Wrestle /
// Fend / Stand Firm / Strip Ball / Juggernaut / Pro), Frenzy, and the Blitz action.

if (typeof module !== 'undefined') {
    var { COLS, ROWS, blockDiceCount, countAssists, getPushSquares, isAdjacent, isStanding, looseBallAt, markStunned, playerAt, sqLabel, teamRerollsLeft } = require('./helpers.js');
    var { d6, rollBlockDice, rollCrowdInjury, rush } = require('./dice.js');
    var { endActivation, endTurn } = require('./core.js');
    var { _consumeTeamReroll, _offerReroll, _traitChecks, knockDown, pn, scatterBall, throwIn } = require('./resolve.js');
}

function declareBlock(G, att, def) {
    const t = _traitChecks(G, att, true);
    if (t.abort) return t.msg;
    const prefix = t.msg;

    let { attStr, defStr } = countAssists(G, att, def);
    if (G.cheeringFansBonus === att.side || G.cheeringFansBonus === 'both') {
        attStr += 1;
        // On a tie ('both'), spend only this side's half — the other team keeps
        // their +1 for their own next block.
        G.cheeringFansBonus = G.cheeringFansBonus === 'both'
            ? (att.side === 'home' ? 'away' : 'home')
            : null;
    }
    const { dice, chooser }  = blockDiceCount(attStr, defStr);
    const rolls = rollBlockDice(dice);

    G.hasBlocked = true;   // block thrown — bars cancel for the rest of this activation

    G.block = {
        att, def, rolls, chooser,
        phase: 'pick-face',
        chosenFace:  null,
        pushSquares: null,
    };

    if (G.animalSavagery) return prefix;
    return (prefix ? prefix + ' ' : '') + `${pn(att)} (ST${attStr}) [[block:blocks]] ${pn(def)} (ST${defStr}) · ${dice}d`;
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

        case 'BOTH_DOWN':
            return _bothDown(G, att, def);

        case 'PUSH':
        case 'DEF_STUMBLES':
        case 'DEF_DOWN':
            return _startPush(G, att, def);
    }
}

// ── _consumeTeamReroll ────────────────────────────────────────────
// Spends a normal team reroll if any remain, otherwise the Leader reroll.

function rerollBlockDice(G) {
    if (!G.block || G.block.phase !== 'pick-face' || G.block.rerolled) return null;
    const att = G.block.att;
    if (teamRerollsLeft(G, att.side) <= 0) return null;
    _consumeTeamReroll(G, att.side);
    G.block.rolls    = rollBlockDice(G.block.rolls.length);
    G.block.rerolled = true;
    return `${pn(att)} uses a team reroll — block dice rerolled.`;
}

function declareProBlock(G) {
    if (!G.block || G.block.phase !== 'pick-face' || G.block.rerolled) return null;
    const att = G.block.att;
    if (!att.skills?.includes('Pro') || att.usedPro) return null;
    G.block.phase = 'pro-pick-die';
    return `${pn(att)} [[skill:Pro]] — pick a die to reroll.`;
}

function proBlockRerollDie(G, idx) {
    if (!G.block || G.block.phase !== 'pro-pick-die') return null;
    const att = G.block.att;
    if (idx < 0 || idx >= G.block.rolls.length) return null;

    att.usedPro      = true;        // once per activation
    G.block.rerolled = true;        // once attempted, no other reroll on these dice
    G.block.phase    = 'pick-face';

    const proRoll = d6();
    if (proRoll < 3) return `${pn(att)} [[skill:Pro]] (${proRoll}) — no reroll.`;
    G.block.rolls[idx] = { ...rollBlockDice(1)[0] };
    return `${pn(att)} [[skill:Pro]] (${proRoll}+) — die rerolled.`;
}

// ── _startPush ────────────────────────────────────────────────────
// Sets up a push: builds the candidate squares and offers the target's Stand
// Firm — unless a Juggernaut attacker is blitzing, which switches it off. Auto-
// resolves a push that can only go into the crowd. G.block.chosenFace marks
// whether the defender merely shifts (PUSH) or is pushed and falls.

function _startPush(G, att, def) {
    G.block.phase       = 'pick-push';
    G.block.pushSquares = getPushSquares(G, att, def);
    // Whether the defender actually falls — Dodge turns Defender Stumbles into a
    // plain push (unless the attacker has Tackle). Mirror pickPushSquare's logic
    // so the message matches the outcome.
    const id = G.block.chosenFace.id;
    const falls = id === 'DEF_DOWN'
        || (id === 'DEF_STUMBLES' && (!def.skills?.includes('Dodge') || att.skills?.includes('Tackle')));
    const prefix = `${pn(def)} is pushed back${falls ? ' and falls!' : '.'}  `;
    if (def.skills?.includes('Stand Firm') && !(att.skills?.includes('Juggernaut') && G.blitz)) {
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

// ── Both Down resolution (with optional Wrestle) ──────────────────
// Wrestle lets either player, on a Both Down, place BOTH players prone with no
// armour rolls. This is NOT a turnover — Placed Prone is distinct from a
// Knock-down (see resolveWrestle). It is optional, so it is offered as a choice;
// it overrides the opponent's Block.

function _bothDown(G, att, def) {
    // Juggernaut (during a Blitz): the defender cannot use Wrestle against this
    // player, and the attacker may treat any Both Down as a push instead.
    if (G.blitz && att.skills?.includes('Juggernaut')) {
        G.block.phase = 'juggernaut-choice';
        return `${pn(att)} may use [[skill:Juggernaut]] — treat Both Down as a push?`;
    }

    // Queue the players who may choose to use Wrestle. Offer the defender first
    // (the common defensive use). Skip the attacker when they have Block —
    // staying up is strictly better, so they would never wrestle.
    const queue = [];
    if (def.skills?.includes('Wrestle')) queue.push('def');
    if (att.skills?.includes('Wrestle') && !att.skills?.includes('Block')) queue.push('att');

    if (queue.length > 0) return _offerWrestle(G, att, def, queue);
    return _resolveBothDownNormal(G, att, def);
}

function _offerWrestle(G, att, def, queue) {
    const player = queue[0] === 'def' ? def : att;
    G.block.phase        = 'wrestle-choice';
    G.block.wrestleQueue = queue;
    G.block.wrestleSide  = player.side;
    return `${pn(player)} may use [[skill:Wrestle]] — drag both players down?`;
}

// ── _endNoTurnoverBlock ───────────────────────────────────────────
// Ends (or continues) a blocker's activation after a block that did NOT cause a
// turnover. A blitzer with movement left — MA or a Rush — keeps their activation
// so they can carry on moving; everyone else is done. Always clears G.targeting
// (left set by the blitz; a stale value soft-locks the coach). `wasBlitz` must
// be captured before G.blitz is nulled. Returns a short log suffix.

function _endNoTurnoverBlock(G, att, wasBlitz) {
    if (wasBlitz && (att.maLeft + att.rushLeft) > 0) {
        G.targeting = null;
        return att.maLeft > 0 ? ` · ${att.maLeft} MA left` : ' · may rush';
    }
    endActivation(G);
    return '';
}

// Resolves a Both Down with no Wrestle used: players with Block keep their
// footing; the rest are knocked down (armour rolls). Turnover if the active
// attacker goes down.

function _resolveBothDownNormal(G, att, def) {
    const attHasBlock = att.skills?.includes('Block');
    const defHasBlock = def.skills?.includes('Block');
    const attHadBall  = !attHasBlock && att.hasBall;
    const defHadBall  = !defHasBlock && def.hasBall;
    const attInj      = attHasBlock ? null : knockDown(G, att);
    const defInj      = defHasBlock ? null : knockDown(G, def, { attacker: att });
    const scatterMsg  = (attHadBall || defHadBall) ? ' ' + scatterBall(G) : '';
    const wasBlitz    = G.blitz;
    G.block = null;
    G.blitz = null;

    if (attHasBlock) {
        const tail = _endNoTurnoverBlock(G, att, wasBlitz);   // no turnover
        if (defHasBlock) return `Both keep their footing (Block).${tail}`;
        return `${pn(def)} knocked down! ${defInj}${scatterMsg} ${pn(att)} keeps footing (Block).${tail}`;
    }
    att.usedAction = true;
    G.activated = null;
    endTurn(G);
    if (defHasBlock) return `${pn(att)} knocked down! ${attInj}${scatterMsg} ${pn(def)} keeps footing (Block). TURNOVER`;
    return `Both knocked down! ${pn(att)}: ${attInj} ${pn(def)}: ${defInj}${scatterMsg} TURNOVER`;
}

// ── resolveWrestle ────────────────────────────────────────────────
// Called after a Both Down suspends into G.block.phase='wrestle-choice'.
// use=true : both players placed prone, no armour rolls. This is NOT a turnover
//            — Wrestle Places players Prone, which is distinct from a Knock-down,
//            and only a Knock-down of the active player ends the turn (BB2020).
//            The active player's action simply ends; their team carries on.
// use=false: offer the next eligible player, else resolve the Both Down normally.

function resolveWrestle(G, use) {
    if (!G.block || G.block.phase !== 'wrestle-choice') return null;
    const { att, def } = G.block;

    if (!use) {
        G.block.wrestleQueue.shift();
        if (G.block.wrestleQueue.length > 0) return _offerWrestle(G, att, def, G.block.wrestleQueue);
        return _resolveBothDownNormal(G, att, def);
    }

    const wrestler = G.block.wrestleQueue[0] === 'def' ? def : att;

    // Both players are Placed Prone — no armour rolls for either. A knocked-down
    // player drops the ball, which then scatters.
    let scatterMsg = '';
    [att, def].forEach(p => {
        p.status = 'prone';
        if (p.hasBall) {
            p.hasBall      = false;
            G.ball.carrier = null;
            G.ball.col     = p.col;
            G.ball.row     = p.row;
            scatterMsg     = ' ' + scatterBall(G);
        }
    });

    // Placed Prone, not Knocked Down → no turnover. End the active player's
    // activation (their team continues) and clear blitz targeting so the coach
    // isn't soft-locked.
    G.block        = null;
    G.blitz        = null;
    G.targeting    = null;
    att.usedAction = true;
    G.activated    = null;
    return `${pn(wrestler)} uses [[skill:Wrestle]]! Both players are placed prone.${scatterMsg}`;
}

// ── resolveJuggernaut ─────────────────────────────────────────────
// Called after a Both Down (during a Blitz) suspends into
// G.block.phase='juggernaut-choice'.
// use=true : treat the Both Down as a plain push — attacker stays up, no
//            turnover; the target's Stand Firm is also off (see _startPush).
// use=false: resolve as a normal Both Down (Wrestle stays negated by Juggernaut).

function resolveJuggernaut(G, use) {
    if (!G.block || G.block.phase !== 'juggernaut-choice') return null;
    const { att, def } = G.block;
    if (use) {
        G.block.chosenFace = { id: 'PUSH' };
        return `${pn(att)} uses [[skill:Juggernaut]]! ` + _startPush(G, att, def);
    }
    return _resolveBothDownNormal(G, att, def);
}

// ── pickPushSquare ────────────────────────────────────────────────
// Moves the defender, optionally knocks them down, offers follow-up.

function pickPushSquare(G, col, row) {
    const { att, def, chosenFace, frenzy } = G.block;
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
        const followUp = G.block.pendingFollowUp || { att, def, vacCol, vacRow, frenzy };
        G.block = { phase: 'follow-up', att: followUp.att, def: followUp.def, vacCol: followUp.vacCol, vacRow: followUp.vacRow, frenzy: followUp.frenzy };
        if (_fendEligible(followUp.def, followUp.att, G)) { G.block.phase = 'fend-choice'; return msg + ` ${pn(followUp.def)} may use [[skill:Fend]] — deny follow-up?`; }
        if (followUp.att.skills?.includes('Frenzy')) return msg + ' ' + resolveFollowUp(G, true);
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
    const scatterPending = ballDropped || looseBallAt(G, col, row);

    if (chainVictim) {
        // Preserve the original follow-up data so we can restore it after all
        // chain pushes resolve. For nested chains, pendingFollowUp already holds it.
        const pendingFollowUp = G.block.pendingFollowUp || { att, def, vacCol, vacRow, scatterPending, frenzy };
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

    const followUp = G.block.pendingFollowUp || { att, def, vacCol, vacRow, scatterPending, frenzy };
    G.block = { phase: 'follow-up', att: followUp.att, def: followUp.def, vacCol: followUp.vacCol, vacRow: followUp.vacRow, scatterPending: followUp.scatterPending, frenzy: followUp.frenzy };
    if (_fendEligible(followUp.def, followUp.att, G)) { G.block.phase = 'fend-choice'; return msg + ` ${pn(followUp.def)} may use [[skill:Fend]] — deny follow-up?`; }
    if (followUp.att.skills?.includes('Frenzy')) return msg + ' ' + resolveFollowUp(G, true);
    return msg + ' Follow up?';
}

// ── _fendEligible / resolveFend ───────────────────────────────────
// Fend (ACTIVE): the defending coach may deny the attacker's follow-up.
// Cannot be used against Ball & Chain, or Juggernaut during a Blitz.

function _fendEligible(def, att, G) {
    return def?.skills?.includes('Fend')
        && !att.skills?.includes('Ball & Chain')
        && !(att.skills?.includes('Juggernaut') && G.blitz);
}

function resolveFend(G, use) {
    if (!G.block || G.block.phase !== 'fend-choice') return null;
    const { att } = G.block;
    G.block.phase = 'follow-up';
    if (use) {
        // Fend used: mark the block so resolveFollowUp ignores Frenzy's mandatory follow-up.
        G.block.fendUsed = true;
        return `[[skill:Fend]]! ${resolveFollowUp(G, false)}`;
    }
    // Fend declined: proceed with normal follow-up flow.
    if (att.skills?.includes('Frenzy')) return resolveFollowUp(G, true);
    return 'Follow up?';
}

// ── resolveFollowUp ───────────────────────────────────────────────
// Commits attacker position, then scatters the ball if loose.

function resolveFollowUp(G, followUp) {
    if (!G.block || G.block.phase !== 'follow-up') return null;
    const { att, def, vacCol, vacRow, scatterPending, frenzy, fendUsed } = G.block;

    // Fend overrides Frenzy's mandatory follow-up — checked first.
    if (fendUsed)                         followUp = false;
    else if (att.skills?.includes('Frenzy')) followUp = true;

    if (followUp) {
        att.col = vacCol;
        att.row = vacRow;
    }

    const followMsg = followUp ? `${pn(att)} follows up` : `${pn(att)} stays`;

    // Strip Ball (ACTIVE): attacker's coach may force a pushed-back ball carrier to drop the ball.
    // Only meaningful on a plain PUSH (def still standing, hasBall still set).
    // For knockdown results, hasBall was already cleared by knockDown in pickPushSquare.
    if (att.skills?.includes('Strip Ball') && def?.hasBall && def.col >= 0) {
        G.block = { phase: 'strip-ball-choice', att, def, frenzy, scatterPending };
        return `${followMsg} — use [[skill:Strip Ball]] against ${pn(def)}?`;
    }

    G.block = null;

    const scatterMsg = scatterPending ? ' ' + scatterBall(G) : '';

    // Frenzy second block: only on the first block, def still standing and adjacent
    // (if Fend denied the follow-up, att didn't move and is no longer adjacent — naturally blocked).
    if (!frenzy && att.skills?.includes('Frenzy') && def && def.col >= 0 && isStanding(def) && isAdjacent(att, def)) {
        const pre = `${followMsg}${scatterMsg} `;
        if (G.blitz) {
            if (att.maLeft > 0) {
                att.maLeft--;
            } else if (att.rushLeft > 0) {
                const { roll, failed } = rush();
                att.rushLeft--;
                if (failed) {
                    // Failed GFI for the second block — offer a reroll, like the first block.
                    const failBase = pre + `— [[skill:Frenzy]] rush (rolled ${roll}) fails! `;
                    const { roll: r2, failed: f2 } = rush();
                    return _offerReroll(G, att, {
                        rerolled: false, label: 'rush', secondFailed: f2, baseMsg: failBase,
                        successMsg: `Team reroll: ${pn(att)} [[move:rushes]] (rolled ${r2}). `,
                        failMsg:    `Team reroll: ${pn(att)} fails rush again (rolled ${r2}). `,
                        onSuccess: (G, suffix) => _throwFrenzySecondBlock(G, att, def, pre + suffix),
                        onFail:    (G, suffix) => _frenzyGfiTurnover(G, att, failBase + suffix),
                    });
                }
            } else {
                // No MA left, no Rush available — second block impossible
                G.blitz = null;
                G.targeting = null;   // clear blitz targeting so the coach isn't soft-locked
                att.usedAction = true;
                G.activated = null;
                return pre + `— no MA for [[skill:Frenzy]] second block.`;
            }
        }
        return _throwFrenzySecondBlock(G, att, def, pre);
    }

    // Normal end of activation — a blitzer with movement (MA or a Rush) left
    // keeps acting; otherwise the activation ends.
    const wasBlitz = G.blitz;
    G.blitz = null;
    return followMsg + _endNoTurnoverBlock(G, att, wasBlitz) + scatterMsg;
}

// Rolls the mandatory Frenzy second block once its movement cost (if any) is paid.
function _throwFrenzySecondBlock(G, att, def, preMsg) {
    const { attStr, defStr } = countAssists(G, att, def);
    const { dice, chooser }  = blockDiceCount(attStr, defStr);
    const rolls = rollBlockDice(dice);
    G.hasBlocked = true;
    // frenzy: true marks this as the second block so resolveFollowUp won't spawn a third.
    G.block = { att, def, rolls, chooser, phase: 'pick-face', chosenFace: null, pushSquares: null, frenzy: true };
    const maMsg = G.blitz ? ` · ${att.maLeft} MA left` : '';
    return `${preMsg}[[skill:Frenzy]]! Second block — ${pn(att)} (ST${attStr}) [[block:blocks]] ${pn(def)} (ST${defStr}) · ${dice}d${maMsg}`;
}

// A failed Go For It taken for the Frenzy second block: attacker down, turnover.
function _frenzyGfiTurnover(G, att, msg) {
    let injMsg = knockDown(G, att);
    if (!G.ball.carrier && G.ball.col === att.col && G.ball.row === att.row) injMsg += ' ' + scatterBall(G);
    endTurn(G);   // clears the activation (blitz/targeting) and flips the turn
    return `${msg}${injMsg} TURNOVER`;
}

// ── resolveStripBall ──────────────────────────────────────────────
// Called after the Strip Ball choice is offered.
// use=true : defender drops the ball at their current square, ball bounces.
// use=false: skip, proceed to Frenzy check / end activation as normal.

function resolveStripBall(G, use) {
    if (!G.block || G.block.phase !== 'strip-ball-choice') return null;
    const { att, def, frenzy, scatterPending } = G.block;
    G.block = null;

    let msg = '';
    if (use) {
        def.hasBall    = false;
        G.ball.carrier = null;
        G.ball.col     = def.col;
        G.ball.row     = def.row;
        msg = `[[skill:Strip Ball]]! ${pn(def)} drops the ball! ` + scatterBall(G) + ' ';
    }

    const scatterMsg = scatterPending ? ' ' + scatterBall(G) : '';

    // Frenzy second block (same conditions as resolveFollowUp).
    if (!frenzy && att.skills?.includes('Frenzy') && def && def.col >= 0 && isStanding(def) && isAdjacent(att, def)) {
        if (G.blitz) {
            if (att.maLeft > 0) {
                att.maLeft--;
            } else if (att.rushLeft > 0) {
                const { roll, failed } = rush();
                att.rushLeft--;
                if (failed) {
                    let injMsg = knockDown(G, att);
                    if (!G.ball.carrier && G.ball.col === att.col && G.ball.row === att.row) injMsg += ' ' + scatterBall(G);
                    G.blitz = null;
                    att.usedAction = true;
                    G.activated = null;
                    endTurn(G);
                    return `${msg}[[skill:Frenzy]] rush (rolled ${roll}) fails! ${injMsg} TURNOVER`;
                }
            } else {
                G.blitz = null;
                att.usedAction = true;
                G.activated = null;
                return `${msg}no MA for [[skill:Frenzy]] second block.`;
            }
        }
        const { attStr, defStr } = countAssists(G, att, def);
        const { dice, chooser }  = blockDiceCount(attStr, defStr);
        const rolls = rollBlockDice(dice);
        G.block = { att, def, rolls, chooser, phase: 'pick-face', chosenFace: null, pushSquares: null, frenzy: true };
        const maMsg = G.blitz ? ` · ${att.maLeft} MA left` : '';
        return `${msg}[[skill:Frenzy]]! Second block — ${pn(att)} (ST${attStr}) [[block:blocks]] ${pn(def)} (ST${defStr}) · ${dice}d${maMsg}`;
    }

    if (G.blitz) {
        G.blitz     = null;
        G.targeting = null;
        const maMsg = att.maLeft > 0 ? ` · ${att.maLeft} MA left` : '';
        if (att.maLeft === 0) {
            att.usedAction = true;
            G.activated    = null;
        }
        return msg + maMsg + scatterMsg;
    }

    att.usedAction = true;
    G.activated    = null;
    G.targeting    = null;
    return msg + scatterMsg;
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
        const scatterMsg = pendingFollowUp.scatterPending ? ' ' + scatterBall(G) : '';
        msg += ` Neither player moves.${scatterMsg}`;
        G.block = null;
        if (G.blitz) {
            G.blitz     = null;
            G.targeting = null;
            const maMsg = realAtt.maLeft > 0 ? ` · ${realAtt.maLeft} MA left` : '';
            if (realAtt.maLeft === 0) { realAtt.usedAction = true; G.activated = null; }
            return msg + maMsg;
        }
        realAtt.usedAction = true;
        G.activated = null;
        G.targeting = null;
        return msg;
    }

    // Direct push: defender didn't vacate so no follow-up is possible.
    G.block = null;
    if (G.blitz) {
        G.blitz     = null;
        G.targeting = null;
        const maMsg = att.maLeft > 0 ? ` · ${att.maLeft} MA left` : '';
        if (att.maLeft === 0) { att.usedAction = true; G.activated = null; }
        return msg + maMsg;
    }
    att.usedAction = true;
    G.activated    = null;
    G.targeting    = null;
    return msg;
}

// ── declareFoul / executeFoul / resolveArgueCall ──────────────────
// Foul action: standing player moves adjacent to a prone/stunned enemy
// and kicks them. Armor checked with 2d6 + assists − TZs.
// Doubles on armor OR injury dice → ref spots it → Argue the Call.
// Argue: roll 1d6 — 6 cancels ejection; 1-5 upholds it and ejects the coach
// (that team can never argue again this game). One foul per team per turn.

function activateBlitz(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p) return null;
    G.hasBlitzed = true;
    const t = _traitChecks(G, p, true);
    if (t.abort) return t.msg;
    const prefix = t.msg;

    G.hasBlocked = false;   // fresh activation — no block thrown yet
    G.activated  = p;
    G.blitz      = 'targeting';
    G.targeting  = true;
    if (p.status === 'prone') {
        p.status         = 'active';
        p.maLeft         = Math.max(0, p.maLeft - 3);
        G.blitzFromProne = true;
    }
    if (G.animalSavagery) return prefix;
    return (prefix ? prefix + ' ' : '') + `${pn(p)} [[block:declares blitz]] — click a target`;
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

// Executes the block at the end of a blitz move.
// Trait checks (BH/RS/AS) already ran in activateBlitz — they must not fire again here.
//
// The block itself costs one square of movement. Spend MA if any is left;
// otherwise it requires a Go For It (rush). With neither MA nor a rush left, the
// block cannot be made.
function blitzBlock(G, att, target) {
    if (att.maLeft > 0) {
        att.maLeft -= 1;
        return _throwBlitzBlock(G, att, target, '');
    }
    if (att.rushLeft > 0) {
        const { roll, failed } = rush();
        att.rushLeft -= 1;
        if (!failed) {
            return _throwBlitzBlock(G, att, target, `${pn(att)} [[move:rushes]] to block (rolled ${roll}). `);
        }
        // Failed GFI — pre-roll the reroll attempt so _offerReroll needs no dice knowledge.
        const failBase = `${pn(att)} fails rush (rolled ${roll}). `;
        const { roll: r2, failed: f2 } = rush();
        return _offerReroll(G, att, {
            rerolled: false, label: 'rush', secondFailed: f2, baseMsg: failBase,
            successMsg: `Team reroll: ${pn(att)} [[move:rushes]] (rolled ${r2}). `,
            failMsg:    `Team reroll: ${pn(att)} fails rush again (rolled ${r2}). `,
            onSuccess: (G, suffix) => _throwBlitzBlock(G, att, target, suffix),
            onFail:    (G, suffix) => _blitzGfiTurnover(G, att, failBase + suffix),
        });
    }
    return null;   // no MA, no rush — the block can't be made
}

// Rolls and applies the blitz block once its movement cost has been paid.
function _throwBlitzBlock(G, att, target, preMsg) {
    let { attStr, defStr } = countAssists(G, att, target);
    if (G.cheeringFansBonus === att.side || G.cheeringFansBonus === 'both') {
        attStr += 1;
        // On a tie ('both'), spend only this side's half — the other team keeps
        // their +1 for their own next block.
        G.cheeringFansBonus = G.cheeringFansBonus === 'both'
            ? (att.side === 'home' ? 'away' : 'home')
            : null;
    }
    const { dice, chooser }  = blockDiceCount(attStr, defStr);
    const rolls = rollBlockDice(dice);
    G.hasBlocked = true;   // blitz block thrown — bars cancel for the rest of this activation
    G.block = { att, def: target, rolls, chooser, phase: 'pick-face', chosenFace: null, pushSquares: null };
    return `${preMsg}${pn(att)} (ST${attStr}) [[block:blocks]] ${pn(target)} (ST${defStr}) · ${dice}d`;
}

// A failed Go For It taken to make a blitz block: the attacker is knocked down,
// drops any ball they carried, and the turn ends.
function _blitzGfiTurnover(G, att, msg) {
    let injMsg = knockDown(G, att);
    if (!G.ball.carrier && G.ball.col === att.col && G.ball.row === att.row) injMsg += ' ' + scatterBall(G);
    endTurn(G);   // clears the activation (blitz/targeting) and flips the turn
    return `${msg}${injMsg} TURNOVER`;
}

// ── throwIn ──────────────────────────────────────────────────────
// Ball left the pitch from lastCol/lastRow heading toward nc/nr.
// The crowd throws it back: pick 1 of 3 inward directions (1d6),
// travel 2d6-1 squares. Repeat if it goes out again.

if (typeof module !== 'undefined') {
    module.exports = { declareBlock, pickBlockFace, rerollBlockDice, declareProBlock, proBlockRerollDie, _startPush, _bothDown, _offerWrestle, _endNoTurnoverBlock, _resolveBothDownNormal, resolveWrestle, resolveJuggernaut, pickPushSquare, _fendEligible, resolveFend, resolveFollowUp, _throwFrenzySecondBlock, _frenzyGfiTurnover, resolveStripBall, resolveStandFirm, activateBlitz, setBlitzTarget, blitzBlock, _throwBlitzBlock, _blitzGfiTurnover };
}

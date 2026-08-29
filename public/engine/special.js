// special.js
// Special actions: Foul (+ Argue the Call / Bribe appeals), Projectile Vomit,
// Stab, and Throw Team-Mate.

if (typeof module !== 'undefined') {
    var { COLS, ROWS, countAssists, countTackleZones, hasDesperate, hasTeamRule, isAdjacent, isStanding, markStunned, recordAction, spendDesperate, sqLabel } = require('./helpers.js');
    var { rollArmourAndInjury, rollCrowdInjury, rollInjury } = require('./dice.js');
    var { endActivation, endTurn } = require('./core.js');
    var { _applyOutcome, _traitChecks, checkTouchdown, pn, scatterBall, throwIn } = require('./resolve.js');
}

// `grudge` declares this as a Grudge Match foul: legal even though the team has
// already fouled this turn, and the fouler cannot be Sent-off for it. The flag
// rides on G until executeFoul resolves it.
function declareFoul(G, playerId, grudge = false) {
    const p = G.players.find(p => p.id === playerId);
    if (!p) return null;
    const t = _traitChecks(G, p, false);
    if (t.abort) return t.msg;
    const prefix = t.msg;
    if (grudge) {
        if (!hasDesperate(G, p.side, 'grudgeMatch')) return null;
        spendDesperate(G, p.side, 'grudgeMatch');
        G.grudgeFoul = true;
    }
    G.activated = p;
    recordAction(G, p, 'Foul');
    G.sel       = p;
    G.fouling   = true;
    if (G.animalSavagery) return prefix;
    return (prefix ? prefix + ' ' : '') + `${pn(p)} [[foul:declares Foul]] — move adjacent to a prone/stunned enemy.`;
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

    if (roll >= def.av) {
        const { d1: di1, d2: di2, injuryRoll, outcome } = rollInjury(def);
        if (di1 === di2) spotted = true;
        // Under Scrutiny — the DEFENDER's team prayed, so the fouler is spotted
        // automatically whenever armour breaks, doubles or not.
        if ((G.prayers?.[def.side] || []).includes('underScrutiny')) spotted = true;
        msg += `AV broken! Inj ${injuryRoll}: ${_applyOutcome(def, outcome)}`;
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

    // Grudge Match — this foul is off the books: the player cannot be Sent-off
    // for it, whatever the dice said.
    if (G.grudgeFoul) {
        G.grudgeFoul = false;
        msg += ' Grudge Match — no sending-off for this one.';
        spotted = false;
    }

    if (spotted) {
        msg += ' Ref spots the foul!';
        if (G.coachEjected[att.side]) {
            att.status = 'casualty'; att.col = -1; att.row = -1;
            endTurn(G);
            return msg + ` ${pn(att)} ejected (coach already sent off). TURNOVER`;
        }
        if ((G.bribes?.[att.side] || 0) > 0) {
            G.pending = { kind: 'bribe', attId: att.id, side: att.side };
            return msg + ' Use a bribe?';
        }
        G.pending = { kind: 'argue', attId: att.id, side: att.side };
        return msg + ' Argue the call?';
    }

    return msg;
}

// ── resolveArgueCall ──────────────────────────────────────────────
// Called after executeFoul suspends into G.pending (kind 'argue').
// use=true: roll 1d6 against the Argue the Call table —
//     1    the player is sent off AND the coach may not argue again this game
//     2-5  the player is sent off; the coach keeps the right to argue later
//     6    the referee relents and the player stays on the pitch
//   Only a 1 costs the coach the argument: a 2-5 is an ordinary sending-off.
// use=false: accept the ejection without risking the coach.
//
// Bribery and Corruption lets a team re-roll a natural 1 here, once per game.
// It is applied automatically: a 1 is the worst result on the table, so there
// is never a reason to decline beyond hoarding it for a later foul.

function resolveArgueCall(G, use) {
    if (G.pending?.kind !== 'argue') return null;
    const { attId, side } = G.pending;
    G.pending = null;
    const att = G.players.find(p => p.id === attId);
    if (!att) return null;

    if (use) {
        let roll   = Math.floor(Math.random() * 6) + 1;
        let prefix = `Argue the call — rolled ${roll}`;

        if (roll === 1 && hasTeamRule(G, side, 'Bribery and Corruption')
                       && !G.corruptionRerollUsed[side]) {
            G.corruptionRerollUsed[side] = true;
            roll = Math.floor(Math.random() * 6) + 1;
            prefix += `: Bribery and Corruption re-rolls it — ${roll}`;
        }

        if (roll === 6) {
            return `${prefix}: ejection overruled! ${pn(att)} stays on the pitch.`;
        }

        att.status = 'casualty'; att.col = -1; att.row = -1;
        endTurn(G);
        if (roll === 1) {
            // Only here does the coach lose the right to argue again.
            G.coachEjected[side] = true;
            return `${prefix}: upheld! ${pn(att)} ejected! ${side.toUpperCase()} coach sent off for the rest of the game. TURNOVER`;
        }
        return `${prefix}: upheld! ${pn(att)} ejected. TURNOVER`;
    }

    // Accept the call
    att.status = 'casualty'; att.col = -1; att.row = -1;
    endTurn(G);
    return `${pn(att)} ejected. TURNOVER`;
}

// ── resolveBribe ──────────────────────────────────────────────────
// use=true: spend a bribe and roll 2+. Success: player stays. Fail (1):
//   bribe wasted, then fall through to argue the call.
// use=false: decline the bribe, go straight to argue the call.

function resolveBribe(G, use) {
    if (G.pending?.kind !== 'bribe') return null;
    const { attId, side } = G.pending;
    G.pending = null;
    const att = G.players.find(p => p.id === attId);
    if (!att) return null;

    if (use) {
        G.bribes[side] = Math.max(0, (G.bribes[side] || 0) - 1);
        const roll = Math.floor(Math.random() * 6) + 1;
        if (roll >= 2) {
            return `Bribe accepted — rolled ${roll}! ${pn(att)} stays on the pitch.`;
        }
        // Bribe wasted — fall through to argue
        G.pending = { kind: 'argue', attId, side };
        return `Bribe wasted — rolled ${roll}! Argue the call?`;
    }

    // Declined — go straight to argue
    G.pending = { kind: 'argue', attId, side };
    return 'Bribe declined. Argue the call?';
}

// ── activateBlitz ─────────────────────────────────────────────────
// Step 1: declare blitz. Prone blitzer stands up immediately.

function declarePV(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p) return null;
    const t = _traitChecks(G, p, false);
    if (t.abort) return t.msg;
    const prefix = t.msg;

    G.activated   = p;
    recordAction(G, p, 'Vomit');
    G.sel         = p;
    G.blitz       = null;
    G.pvTargeting = true;
    G.targeting   = true;
    if (G.animalSavagery) return prefix;
    return (prefix ? prefix + ' ' : '') + `${pn(p)} [[skill:Projectile Vomit]] — select an adjacent standing enemy.`;
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
    G.pvTargeting = false;
    G.targeting   = null;
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

    msg += `AV ${armorRoll}/${victim.av} broken! Inj ${injuryRoll}: ${_applyOutcome(victim, outcome)}`;
    if (hadBall) msg += ' ' + scatterBall(G);
    return msg;
}

// ── declareStab ───────────────────────────────────────────────────
// Enters Stab targeting mode. A Stab Special Action may be declared by any
// activated player with the skill (no per-turn limit). It may also replace
// the Block made as part of a Blitz — declared at the point of contact, not
// up front — so this clears G.blitz. Either way the activation ends once the
// Stab is performed (executeStab).

function declareStab(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p) return null;
    const t = _traitChecks(G, p, true);
    if (t.abort) return t.msg;
    const prefix = t.msg;

    G.activated  = p;
    recordAction(G, p, 'Stab');
    G.sel        = p;
    G.blitz      = null;
    G.stabbing   = true;
    G.targeting  = true;
    if (G.animalSavagery) return prefix;
    return (prefix ? prefix + ' ' : '') + `${pn(p)} [[skill:Stab]] — select an adjacent standing enemy.`;
}

// ── executeStab ───────────────────────────────────────────────────
// Resolves a Stab action: an Armour Roll made directly against the target,
// which cannot be modified in any way (attacker = null → no Mighty Blow; the
// only armour modifier in the engine). If armour breaks, a normal Injury Roll
// follows (Thick Skull / Stunty still apply to injury). No block dice, no push,
// no knockdown unless injured, and a Stab never causes a turnover.

function executeStab(G, targetId) {
    if (!G.stabbing || !G.activated) return null;
    const att = G.activated;
    const def = G.players.find(p => p.id === targetId);
    if (!def || def.side === att.side || !isAdjacent(att, def) || !isStanding(def)) return null;

    G.stabbing     = false;
    G.targeting    = null;
    att.usedAction = true;
    G.activated    = null;

    let msg = `${pn(att)} [[skill:Stab]] → ${pn(def)}! `;
    const { armorRoll, armorBroken, injuryRoll, outcome } = rollArmourAndInjury(def, null);
    if (!armorBroken) return msg + `AV ${armorRoll}/${def.av} — armour holds.`;

    const hadBall = def.hasBall;
    if (hadBall) {
        def.hasBall    = false;
        G.ball.carrier = null;
        G.ball.col     = def.col;
        G.ball.row     = def.row;
    }

    msg += `AV ${armorRoll}/${def.av} broken! Inj ${injuryRoll}: ${_applyOutcome(def, outcome)}`;
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
    const t = _traitChecks(G, p, false);
    if (t.abort) return t.msg;
    const prefix = t.msg;

    G.activated = p;
    recordAction(G, p, 'TTM');
    G.sel       = p;
    G.throwTeamMate = { phase: 'pick-missile' };
    G.targeting     = true;
    if (G.animalSavagery) return prefix;
    return (prefix ? prefix + ' ' : '') + `${pn(p)} [[skill:declares Throw Team-Mate]] — pick an adjacent teammate with Right Stuff.`;
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

    if (p.skills?.includes('Always Hungry')) {
        const ahRoll = Math.floor(Math.random() * 6) + 1;
        let prefix = `${pn(p)} [[skill:Always Hungry]] — rolled ${ahRoll}: `;
        if (ahRoll === 1) {
            const eatRoll = Math.floor(Math.random() * 6) + 1;
            prefix += `tries to eat ${pn(missile)}! Rolled ${eatRoll}: `;
            if (eatRoll === 1) {
                // Eaten — no apothecary or regeneration may be used
                const hadBall = missile.hasBall;
                if (hadBall) {
                    missile.hasBall = false;
                    G.ball.carrier  = null;
                    G.ball.col      = missile.col;
                    G.ball.row      = missile.row;
                }
                missile.col    = -1;
                missile.row    = -1;
                missile.status = 'casualty';
                missile.eaten  = true;
                G.throwTeamMate = null;
                const ballMsg = hadBall ? scatterBall(G) + ' ' : '';
                endTurn(G);
                return prefix + `${pn(missile)} is eaten! ${ballMsg}TURNOVER`;
            }
            // 2+: squirms free → automatic Fumbled Throw
            prefix += `${pn(missile)} squirms free! FUMBLE! `;
            G.throwTeamMate = null;
            G.hasThrownMate = true;
            const throwerCol = p.col;
            const throwerRow = p.row;
            endActivation(G);
            return _ttmResolveFumble(G, missile, throwerCol, throwerRow, prefix);
        }
        // 2+: proceed with throw as normal
        G.throwTeamMate = { phase: 'targeting', missileId };
        return prefix + `${pn(p)} picks up ${pn(missile)} — click target square to throw.`;
    }

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

// ── _ttmResolveFumble ────────────────────────────────────────────────
// Shared fumble resolution: bounce missile ×1 from thrower's square, then land.
// Caller is responsible for calling endActivation before invoking this.

function _ttmResolveFumble(G, missile, throwerCol, throwerRow, msg) {
    const { col: bc, row: br, fromCol: fc, fromRow: fr, msg: bMsg, offPitch } = _ttmScatterNTimes(throwerCol, throwerRow, 1);
    msg += `${pn(missile)} bounces ${bMsg}${offPitch ? ' (off pitch)' : ' to ' + sqLabel(bc, br)}. `;
    return _landMissile(G, missile, bc, br, msg, 1, fc, fr);
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
        return _ttmResolveFumble(G, missile, throwerCol, throwerRow, msg);
    }

    const throwLabel = isSuperb ? 'Superb' : 'Subpar';
    const { col: lc, row: lr, fromCol: fc, fromRow: fr, msg: scMsg, offPitch } = _ttmScatterNTimes(targetCol, targetRow, 3);
    msg += `${throwLabel}! Scatter ×3: ${scMsg}${offPitch ? ' (off pitch)' : ` → ${sqLabel(lc, lr)}`}. `;
    return _landMissile(G, missile, lc, lr, msg, isSuperb ? 0 : 1, fc, fr);
}

// ── Team reroll resolution ────────────────────────────────────────
// _resolveTeamReroll is generic: it dispatches entirely through the
// closures stored in G.pending (kind 'reroll') — no per-roll knowledge here.

// ── _offerReroll ──────────────────────────────────────────────────
// Offers a reroll for a just-failed roll: the player's Pro (once per activation,
// on a 3+) first, then a team reroll (incl. Leader). opts carries the pre-rolled
// retry (secondFailed), display messages, and the onSuccess/onFail resolvers.
// Returns the suspend message, or resolves the failure immediately (onFail) when
// no reroll is available — e.g. a skill reroll was already used on this die.

if (typeof module !== 'undefined') {
    module.exports = { declareFoul, executeFoul, resolveArgueCall, resolveBribe, declarePV, executePV, declareStab, executeStab, declareTTM, pickTTMMissile, _ttmScatterNTimes, _landMissile, _ttmResolveFumble, throwTeamMate };
}

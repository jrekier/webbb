// resolve.js
// Shared resolution primitives: injury application, ball physics (scatter/
// bounce/throw-in/pickup), the catch, touchdown, the reroll machinery, and the
// pre-activation trait gauntlet. Every subsystem below calls down into these.

if (typeof module !== 'undefined') {
    var { COLS, ROWS, countTackleZones, isAdjacent, isStanding, markStunned, playerAt, sqLabel, teamRerollsLeft, trapdoorAt, trapdoorsArmed } = require('./helpers.js');
    var { d6, rollArmourAndInjury, rollCrowdInjury } = require('./dice.js');
    var { endScoringTurn, endTurn, resetAfterTouchdown } = require('./core.js');
}


// ── checkTrapdoor ─────────────────────────────────────────────────
// Called whenever a player ENTERS a square, for any reason — walking, rushing,
// being pushed, landing from a throw. If that square holds a trapdoor and a
// Treacherous Trapdoor prayer has armed them, roll a D6: on a 1 the door swings
// open and the player falls through, taking an injury as if pushed into the
// crowd. A ball they were holding bounces from the square they fell out of.
// Returns a message, or '' when nothing happened.
function checkTrapdoor(G, p) {
    if (!p || p.col < 0 || !trapdoorAt(p.col, p.row) || !trapdoorsArmed(G)) return '';

    const roll = d6();
    if (roll !== 1) return `${pn(p)} steps over the trapdoor (rolled ${roll}). `;

    const col = p.col, row = p.row;
    const hadBall = p.hasBall;
    if (hadBall) { p.hasBall = false; G.ball.carrier = null; G.ball.col = col; G.ball.row = row; }

    const { injuryRoll, outcome } = rollCrowdInjury(p);
    let msg = `The trapdoor opens under ${pn(p)} (rolled ${roll})! Inj ${injuryRoll}: `;
    if (outcome === 'stunned') {
        markStunned(p);
        msg += 'Stunned — placed in reserves.';
    } else if (outcome === 'ko') {
        p.status = 'ko';
        msg += "KO'd!";
    } else {
        p.status = 'casualty';
        msg += 'CASUALTY!';
    }
    p.col = -1;
    p.row = -1;
    // The ball is left behind on the pitch and bounces from that square.
    if (hadBall) msg += ' ' + scatterBall(G);
    return msg + ' ';
}

// ════════════════════════════════════════════════════════════════════════════
// GAME FLOW — IN-PLAY ACTION LIFECYCLE   (while G.phase === 'play')
// (For the phase machine that gets us into 'play', see core.js.)
//
// One activation runs:
//     activate ─▶ choose a MODE ─▶ resolve ─▶ (maybe SUSPEND for a coach
//                 decision ─▶ resume) ─▶ end
//
// activatePlayer / activateMover / activateBlitz / declareX set G.activated and
// one MODE below; the player then moves (movePlayer) and/or taps a target. The
// pre-activation trait gauntlet (_traitChecks) can abort the activation outright.
//
// MODES — the active coach's multi-step action (one at a time):
//     G.blitz          move-then-block    activateBlitz → setBlitzTarget → blitzBlock
//     G.passing        pass               declarePass  → throwBall
//     G.handingOff     hand-off           declareHandoff → doHandoff
//     G.fouling        foul               declareFoul  → executeFoul
//     G.stabbing       Stab               declareStab  → executeStab
//     G.pvTargeting    Projectile Vomit   declarePV    → executePV
//     G.securingBall   Secure the Ball    secureBall   → doSecureRoll
//     G.throwTeamMate  Throw Team-Mate    declareTTM   → pickTTMMissile → throwTeamMate
//     G.animalSavagery berserk redirect   (set by the trait check) → resolveASHit
//     (a plain Move sets only G.activated; a plain Block sets G.block directly.)
//
// SUSPEND → RESUME — resolution pauses to ask a coach yes/no/pick. Some belong to
// the DEFENDING coach; who may answer is gated by the canUse*/can* flags in
// truth.js (getGameContext). Each is resumed by the named resolver:
//     G.block.phase        block sub-machine:
//                            pick-face → pick-push → follow-up, with reaction
//                            branches wrestle / fend / stand-firm / strip-ball /
//                            juggernaut / pro-pick-die.
//                            pickBlockFace, _startPush, pickPushSquare,
//                            resolveFollowUp, resolveWrestle, resolveFend,
//                            resolveStandFirm, resolveStripBall, resolveJuggernaut,
//                            declareProBlock / proBlockRerollDie, rerollBlockDice
//     G.pending = { kind, side, … } — the one suspended coach decision (only one
//                  is ever active; G.pending.side is who may answer). By kind:
//        'reroll'       Pro/team reroll on a failed roll  useTeamReroll/declineTeamReroll
//        'passReroll'   passer's Pass-skill reroll        resolvePassReroll
//        'intercept'    defender picks an interceptor     chooseInterceptor
//        'divingTackle' defender's Diving Tackle on a dodge   resolveDivingTackle
//        'argue'        appeal an ejected foul            resolveArgueCall
//        'bribe'        bribe the ref on an ejected foul  resolveBribe
//
// END — endActivation (player done, team plays on) or endTurn (turnover / scored).
// Both clear the MODE and SUSPEND fields (see core.js endActivation/endTurn). A
// touchdown routes through checkTouchdown → endScoringTurn.
// ════════════════════════════════════════════════════════════════════════════

// ── pn ────────────────────────────────────────────────────────────
// Tagged player name for rich log rendering. Side drives the color.
function pn(p) { return `[[${p.side}:${p.name.replace(/[\[\]]/g, '')}]]`; }

// ── _applyOutcome ─────────────────────────────────────────────────
// Applies a broken-armour injury outcome to a player and returns the canonical
// log label. Stunned routes through markStunned (so the recover-next-turn timing
// is set); KO and Casualty leave the pitch.
function _applyOutcome(p, outcome) {
    if (outcome === 'stunned') { markStunned(p); return 'Stunned.'; }
    if (outcome === 'ko')      { p.status = 'ko';       p.col = -1; p.row = -1; return "KO'd!"; }
    p.status = 'casualty'; p.col = -1; p.row = -1; return 'CASUALTY!';
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
    return `AV ${armorRoll}/${p.av} broken! Inj ${injuryRoll}: ${_applyOutcome(p, outcome)}`;
}

// ── _boneHeadCheck / _reallyStupidCheck / _animalSavageryCheck ────
// Pre-activation trait checks. Each returns { msg, abort } when the
// trait fires, null when absent.

// Shared cleanup when a pre-activation trait (Bone Head / Really Stupid /
// Animal Savagery with no target) fails: the player is Distracted and their
// activation is wasted. Clears ALL activation/targeting state — in particular
// G.targeting, which a block declaration left set; leaving it would soft-lock
// the UI in targeting mode with no active player.
function _failTrait(G, p) {
    p.distracted    = true;
    p.usedAction    = true;
    G.activated     = null;
    G.block         = null;
    G.blitz         = null;
    G.targeting     = null;
    G.throwTeamMate = null;
}

function _boneHeadCheck(G, p) {
    if (!p.skills?.includes('Bone Head')) return null;
    const roll = Math.floor(Math.random() * 6) + 1;
    if (roll >= 2) {
        p.distracted = false;
        return { msg: `${pn(p)} [[skill:Bone Head]] (rolled ${roll}) — OK!`, abort: false };
    }
    _failTrait(G, p);
    return { msg: `${pn(p)} [[skill:Bone Head]] (rolled ${roll}) — activation lost!`, abort: true };
}

function _reallyStupidCheck(G, p) {
    if (!p.skills?.includes('Really Stupid')) return null;
    // +2 modifier if a non-Distracted, non-RS teammate is adjacent (BB2020 rule)
    const hasFriend = G.players.some(f =>
        f.id !== p.id && f.side === p.side && isStanding(f)
        && !f.distracted
        && !f.skills?.includes('Really Stupid')
        && isAdjacent(p, f)
    );
    const target = hasFriend ? 2 : 4;
    const roll   = Math.floor(Math.random() * 6) + 1;
    const ctx    = hasFriend ? 'friend nearby' : 'alone';
    if (roll >= target) {
        p.distracted = false;
        return { msg: `${pn(p)} [[skill:Really Stupid]] (${ctx}, rolled ${roll}/${target}+) — OK!`, abort: false };
    }
    _failTrait(G, p);
    return { msg: `${pn(p)} [[skill:Really Stupid]] (${ctx}, rolled ${roll}/${target}+) — too stupid to act!`, abort: true };
}

function _animalSavageryCheck(G, p, isBlockOrBlitz) {
    if (!p.skills?.includes('Animal Savagery')) return null;
    const target = isBlockOrBlitz ? 2 : 4;
    const roll   = Math.floor(Math.random() * 6) + 1;
    G.asRolled = true;
    if (roll >= target) {
        p.distracted = false;
        return { msg: `${pn(p)} [[skill:Animal Savagery]] (rolled ${roll}/${target}+) — OK!`, abort: false };
    }

    const base = `${pn(p)} [[skill:Animal Savagery]] (rolled ${roll}/${target}+) — goes berserk!`;
    const adjacentFriends = G.players.filter(f =>
        f.id !== p.id && f.side === p.side && isStanding(f) && f.col >= 0 && isAdjacent(p, f)
    );

    if (adjacentFriends.length === 0) {
        _failTrait(G, p);
        return { msg: base + ' No adjacent teammate — activation lost.', abort: true };
    }

    G.animalSavagery = { phase: 'pick-target', playerId: p.id };
    G.targeting      = true;
    return { msg: base + ' Pick an adjacent teammate to attack.', abort: false };
}

function resolveASHit(G, targetId) {
    if (!G.animalSavagery || G.animalSavagery.phase !== 'pick-target') return null;
    const p      = G.players.find(pl => pl.id === G.animalSavagery.playerId);
    const target = G.players.find(pl => pl.id === targetId);
    if (!p || !target) return null;
    if (target.id === p.id || target.side !== p.side) return null;
    if (!isStanding(target) || target.col < 0 || !isAdjacent(p, target)) return null;

    G.animalSavagery = null;
    G.targeting      = null;

    const hitMsg = knockDown(G, target);
    let msg = `${pn(p)} [[skill:Animal Savagery]] hits ${pn(target)}! ${hitMsg}`;
    if (!G.ball.carrier && G.ball.col === target.col && G.ball.row === target.row) msg += ' ' + scatterBall(G);
    return msg.trimEnd();
}

// ── _traitChecks ──────────────────────────────────────────────────
// Runs the pre-activation trait gauntlet in order: Bone Head → Really Stupid →
// Animal Savagery. Returns { abort, msg }: when abort is true the activation is
// lost and msg is the full reason; otherwise msg is the prefix to prepend to the
// action's log (and G.animalSavagery may have been set for the berserk redirect,
// which the caller checks). isBlockOrBlitz feeds Animal Savagery's easier 2+ test.
function _traitChecks(G, p, isBlockOrBlitz) {
    const bh = p.skills?.includes('Bone Head')      ? _boneHeadCheck(G, p)                       : null;
    if (bh?.abort) return { abort: true, msg: bh.msg };
    const rs = p.skills?.includes('Really Stupid')   ? _reallyStupidCheck(G, p)                   : null;
    if (rs?.abort) return { abort: true, msg: [bh?.msg, rs.msg].filter(Boolean).join(' ') };
    const as = p.skills?.includes('Animal Savagery') ? _animalSavageryCheck(G, p, isBlockOrBlitz) : null;
    if (as?.abort) return { abort: true, msg: [bh?.msg, rs?.msg, as.msg].filter(Boolean).join(' ') };
    return { abort: false, msg: [bh?.msg, rs?.msg, as?.msg].filter(Boolean).join(' ') };
}


// ── declareBlock ─────────────────────────────────────────────────
// Rolls block dice and sets G.block with phase 'pick-face'.
// G.block.frenzy is intentionally absent here. It is only set to true
// by resolveFollowUp when spawning the mandatory Frenzy second block,
// so that resolveFollowUp can distinguish "first block (may still
// trigger Frenzy)" from "second block (Frenzy already spent)".

function _consumeTeamReroll(G, side) {
    if ((G.rerolls?.[side] || 0) > 0) G.rerolls[side] -= 1;
    else                              G.leaderRerollUsed[side] = true;
}

// ── Block-dice rerolls ────────────────────────────────────────────
// During the 'pick-face' phase the active coach may reroll the block dice — a
// team reroll re-rolls them all; Pro re-rolls a single chosen die on a 3+. Only
// one reroll may be used per block (G.block.rerolled), matching Pro's rule that
// once attempted no other reroll may be used on the dice.

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

function scatterBall(G, isKickoff = false) {
    const DC = [ 0, 1, 1, 1, 0,-1,-1,-1];
    const DR = [-1,-1, 0, 1, 1, 1, 0,-1];
    const dir = Math.floor(Math.random() * 8);
    const nc  = G.ball.col + DC[dir];
    const nr  = G.ball.row + DR[dir];

    if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) {
        if (isKickoff) {
            G.ball  = { col: -1, row: -1, carrier: null };
            G.phase = 'kickoff_touchback';
            return `Ball scattered out of play — TOUCHBACK!`;
        }
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
    // True once any reroll (skill or team) has been used/offered on this roll.
    let rerolled = false;

    if (roll !== 6 && roll < target && p.skills?.includes('Sure Hands')) {
        const reroll  = Math.floor(Math.random() * 6) + 1;
        extra         = ` Uses Sure Hands, rerolls: ${reroll}.`;
        roll          = reroll;
        rerolled      = true;
    }

    if (roll >= target || roll === 6) {
        p.hasBall      = true;
        G.ball.carrier = p;
        return `${pn(p)} [[skill:picks up]] the ball (rolled ${roll}, needed ${target}+).${extra}`;
    }

    const failMsg = `${pn(p)} fails to pick up (rolled ${roll}, needed ${target}+).${extra}`;
    // Pre-roll the second attempt now so _resolveTeamReroll needs no dice knowledge.
    const r2 = d6();
    const f2 = r2 !== 6 && r2 < target;
    const msgAtFailure = failMsg + ' ';
    return _offerReroll(G, p, {
        rerolled, label: 'pickup', secondFailed: f2, baseMsg: failMsg + ' ',
        successMsg: `Team reroll: ${pn(p)} [[skill:picks up]] the ball (rolled ${r2}, needed ${target}+). `,
        failMsg:    `Team reroll: ${pn(p)} fails to pick up again (rolled ${r2}, needed ${target}+). `,
        onSuccess: (G, suffix) => {
            p.hasBall      = true;
            G.ball.carrier = p;
            return msgAtFailure + suffix;
        },
        onFail: (G, suffix) => {
            const scatterMsg = scatterBall(G);
            endTurn(G);
            return msgAtFailure + suffix + scatterMsg + ' TURNOVER';
        },
    });
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
    // End the scoring team's turn (advances the turn counter; may end the half).
    const endMsg = endScoringTurn(G, p.side);
    if (endMsg) return `${msg} ${endMsg}`;   // half/game ended here — no fresh drive
    resetAfterTouchdown(G, p.side);
    if (G._koRollMsg) { msg += ` KO rolls: ${G._koRollMsg}.`; G._koRollMsg = null; }
    return msg;
}

// ── doSecureRoll ─────────────────────────────────────────────────
// Rolls 2+ for Secure the Ball. Called once the player is on the
// ball's square. Ends activation on success; turnover on failure.

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

    // Set Piece — the receiving player catches on a 2+. Consumed by the first
    // catch attempt after the throw, success or not.
    const setPiece = G.setPieceCatch === lander.side;
    if (G.setPieceCatch) G.setPieceCatch = null;

    const tzs    = countTackleZones(G, lander.side, col, row);
    const target = setPiece ? 2 : Math.min(lander.ag + (bouncePenalty ? 1 : 0) + tzs, 6);
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

function _offerReroll(G, p, opts) {
    const proAvail  = !opts.rerolled && p.skills?.includes('Pro') && !p.usedPro;
    const teamAvail = !opts.rerolled && teamRerollsLeft(G, p.side) > 0;
    if (!proAvail && !teamAvail) return opts.onFail(G, '');

    G.pending = {
        kind:      'reroll',
        source:    proAvail ? 'pro' : 'team',   // which reroll the coach is being offered
        label:     opts.label,
        side:      p.side,
        playerId:  p.id,
        secondFailed: opts.secondFailed,
        successMsg:   opts.successMsg,
        failMsg:      opts.failMsg,
        onSuccess:    opts.onSuccess,
        onFail:       opts.onFail,
        proRoll:   proAvail ? d6() : 0,
        teamAvail,
    };
    return opts.baseMsg + (proAvail ? `${pn(p)} may use [[skill:Pro]].` : 'Reroll available.');
}

// ── _resolveTeamReroll ────────────────────────────────────────────
// Resolves a pending reroll (Pro or team) once the coach has decided.

function _resolveTeamReroll(G, used) {
    const pr = G.pending;
    G.pending = null;
    if (!pr) return '';

    // ── Pro: a 3+ unlocks the reroll of the single die. Once Pro is attempted
    // (used), no other reroll source may be used on this die.
    if (pr.source === 'pro') {
        if (used) {
            const player = G.players.find(x => x.id === pr.playerId);
            if (player) player.usedPro = true;       // once per activation
            if (pr.proRoll >= 3) {
                const note = `${pn(player)} [[skill:Pro]] (${pr.proRoll}+) — reroll! `;
                return pr.secondFailed ? pr.onFail(G, note) : pr.onSuccess(G, note);
            }
            return pr.onFail(G, `${pn(player)} [[skill:Pro]] (${pr.proRoll}) — no reroll. `);
        }
        // Pro declined (not attempted) — a team reroll may still be used.
        if (pr.teamAvail) {
            G.pending = { ...pr, source: 'team', proRoll: 0 };
            return '';
        }
        return pr.onFail(G, '');
    }

    // ── Team reroll (incl. Leader) ────────────────────────────────
    if (used) _consumeTeamReroll(G, pr.side);
    if (used && !pr.secondFailed) return pr.onSuccess(G, pr.successMsg);
    // Decline: proceed with the original failure (no extra message).
    // Use-and-fail: show the failure message then resolve as failure.
    return pr.onFail(G, used ? pr.failMsg : '');
}

function useTeamReroll(G)     { return _resolveTeamReroll(G, true);  }

function declineTeamReroll(G) { return _resolveTeamReroll(G, false); }

if (typeof module !== 'undefined') {
    module.exports = {
        checkTrapdoor, pn, _applyOutcome, knockDown, _failTrait, _boneHeadCheck, _reallyStupidCheck, _animalSavageryCheck, resolveASHit, _traitChecks, _consumeTeamReroll, throwIn, scatterBall, tryPickup, checkTouchdown, _scatterNTimes, _catchAtSquare, _offerReroll, _resolveTeamReroll, useTeamReroll, declineTeamReroll };
}

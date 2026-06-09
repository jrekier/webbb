// kickoff.js
// The kickoff sequence: the event table, ball scatter, the catch, touchbacks,
// and High Kick placement.

if (typeof module !== 'undefined') {
    var { COLS, ROWS, TURNS, countTackleZones, isInKickerHalf, isStanding, isValidKickTarget, playerAt, rollWeather, sqLabel } = require('./helpers.js');
    var { d6 } = require('./dice.js');
    var { pn, scatterBall } = require('./resolve.js');
}

var KICKOFF_EVENTS = [
    null, null,                // 0–1 unused
    'Get the Ref',             // 2
    'Time-Out',                // 3
    'Solid Defence',           // 4
    'High Kick',               // 5
    'Cheering Fans',           // 6
    'Brilliant Coaching',      // 7
    'Changing Weather',        // 8
    'Quick Snap',              // 9
    'Charge!',                 // 10
    'Dodgy Snack',             // 11
    'Pitch Invasion',          // 12
];

// Rolls 2d6, applies the kickoff event to G, returns a log message.
// For interactive events (Solid Defence, Quick Snap, Charge!) the phase
// is changed and G.pendingKick is set; the caller must call resolveKickScatter
// once the interactive phase confirms. For all other events, the phase is
// left as 'kick' and the scatter resolves immediately.
function _applyKickoffEvent(G, aimCol, aimRow) {
    const die1 = d6();
    const die2 = d6();
    const roll = die1 + die2;
    const name = KICKOFF_EVENTS[roll] || 'Brilliant Coaching';
    G.kickoffEvent = name;

    let msg = `[[skill:Kickoff Event]] (${die1}+${die2}=${roll}): [[skill:${name}]]`;

    if (!G.weather) G.weather = rollWeather();

    switch (name) {

        case 'Get the Ref':
            G.rerolls.home += 1;
            G.rerolls.away += 1;
            msg += ` — Each team gains 1 reroll from the bribed officials!`;
            break;

        case 'Time-Out': {
            const turnInHalf = G.half === 1 ? G.turn : G.turn - TURNS;
            if (turnInHalf >= 4) {
                G.turn -= 1;
                msg += ` — Late in the half! Both teams gain an extra turn.`;
            } else {
                G.turn += 1;
                msg += ` — Early squabble! Both teams lose a turn.`;
            }
            break;
        }

        case 'Solid Defence': {
            const d3 = Math.ceil(d6() / 2);
            G.solidDefenceMovesLeft = d3 + 3;
            G.pendingKick = { col: aimCol, row: aimRow };
            G.phase     = 'kickoff_soliddefence';
            G.setupSide = G.kicker;  // reuse setup drag UI
            msg += ` — ${G.kicker.toUpperCase()} may remove up to ${G.solidDefenceMovesLeft} players and re-set them up.`;
            break;
        }

        case 'High Kick':
            G.highKick = true;
            msg += ` — After the ball lands, one ${G.receiver.toUpperCase()} player may move to that square.`;
            break;

        case 'Cheering Fans': {
            const hc = G.cheerleaders?.home || 0, ac = G.cheerleaders?.away || 0;
            const hr = d6() + hc, ar = d6() + ac;
            msg += ` — HOME ${hr} (${hc} cheerleaders) vs AWAY ${ar} (${ac} cheerleaders).`;
            if (hr > ar) {
                G.cheeringFansBonus = 'home';
                msg += ` HOME fans cheer loudest — HOME's next block gets +1 assist!`;
            } else if (ar > hr) {
                G.cheeringFansBonus = 'away';
                msg += ` AWAY fans cheer loudest — AWAY's next block gets +1 assist!`;
            } else {
                G.cheeringFansBonus = 'both';
                msg += ` Both sets of fans equally loud — both teams' next block gets +1 assist!`;
            }
            break;
        }

        case 'Brilliant Coaching': {
            const ha = G.assistantCoaches?.home || 0, aa = G.assistantCoaches?.away || 0;
            const hr = d6() + ha, ar = d6() + aa;
            msg += ` — HOME ${hr} (${ha} asst. coaches) vs AWAY ${ar} (${aa} asst. coaches).`;
            if (hr > ar) {
                G.rerolls.home += 1;
                msg += ` HOME coach inspired — HOME gains 1 reroll!`;
            } else if (ar > hr) {
                G.rerolls.away += 1;
                msg += ` AWAY coach inspired — AWAY gains 1 reroll!`;
            } else {
                G.rerolls.home += 1;
                G.rerolls.away += 1;
                msg += ` Both coaches equally brilliant — each team gains 1 reroll!`;
            }
            break;
        }

        case 'Changing Weather': {
            const prev = G.weather;
            G.weather = rollWeather();
            msg += ` — Weather changes from ${prev} to ${G.weather}!`;
            if (G.weather === 'Perfect Conditions') {
                G.tripleScatterKick = true;
                msg += ` Clear skies — the ball will scatter 3 times in the air!`;
            }
            break;
        }

        case 'Quick Snap': {
            const d3 = Math.ceil(d6() / 2);
            G.quickSnapMovesLeft = d3 + 1;
            G.quickSnapMoved     = [];
            // Record each receiver's starting position so moves can be undone
            G.quickSnapOrigins   = {};
            G.players.filter(p => p.side === G.receiver && p.col >= 0).forEach(p => {
                G.quickSnapOrigins[p.id] = { col: p.col, row: p.row };
            });
            G.pendingKick = { col: aimCol, row: aimRow };
            G.phase = 'kickoff_quicksnap';
            msg += ` — ${G.receiver.toUpperCase()} may move up to ${G.quickSnapMovesLeft} players 1 square each.`;
            break;
        }

        case 'Charge!': {
            const d3 = Math.ceil(d6() / 2);
            G.chargeMovesLeft = d3 + 1;
            G.pendingKick = { col: aimCol, row: aimRow };
            G.phase  = 'kickoff_charge';
            G.active = G.kicker;
            msg += ` — ${G.kicker.toUpperCase()} may activate up to ${G.chargeMovesLeft} players for a free Move or Blitz!`;
            break;
        }

        case 'Dodgy Snack': {
            const hr = d6(), ar = d6();
            msg += ` — HOME ${hr} vs AWAY ${ar}.`;
            // The lower roller suffers the dodgy snack; a tie hits both.
            const sides = hr === ar ? ['home', 'away'] : (hr < ar ? ['home'] : ['away']);
            for (const side of sides) {
                const onPitch = G.players.filter(p => p.side === side && p.col >= 0 && p.status === 'active');
                if (!onPitch.length) continue;
                const target = onPitch[Math.floor(Math.random() * onPitch.length)];
                const snackRoll = d6();
                if (snackRoll === 1) {
                    target.col = -1; target.row = -1;
                    msg += ` ${pn(target)} violently ill — sent to reserves for the drive! (rolled 1)`;
                } else {
                    const ill = [];
                    if (target.ma > 1) {
                        target.ma -= 1;
                        // maLeft was set from the full MA at drive start; clamp it so the
                        // reduction bites this turn too, not just on the card.
                        target.maLeft = Math.min(target.maLeft ?? target.ma, target.ma);
                        ill.push('ma');
                    }
                    if (target.av > 1) { target.av -= 1; ill.push('av'); }
                    if (ill.length) target.illnesses = ill;
                    msg += ` ${pn(target)} feeling off — MA/AV reduced by 1 for this drive. (rolled ${snackRoll})`;
                }
            }
            break;
        }

        case 'Pitch Invasion': {
            const hf = G.fanFactor?.home || 0, af = G.fanFactor?.away || 0;
            const hr = d6() + hf, ar = d6() + af;
            msg += ` — HOME ${hr} (FF ${hf}) vs AWAY ${ar} (FF ${af}).`;
            const sides = hr === ar ? ['home', 'away'] : (hr < ar ? ['home'] : ['away']);
            for (const side of sides) {
                const onPitch = G.players.filter(p => p.side === side && p.col >= 0 && p.status === 'active');
                if (!onPitch.length) continue;
                const target = onPitch[Math.floor(Math.random() * onPitch.length)];
                target.status = 'stunned';
                target.stunnedThisTurn = true;
                msg += ` ${pn(target)} is knocked over by invading fans — Prone and Stunned!`;
            }
            break;
        }
    }

    return msg;
}

// ── resolveKickScatter ────────────────────────────────────────────
// Lands the ball after a kick. nc/nr is the already-scattered position
// (from declareKick or stored in G.pendingKick for interactive events).
// Only handles Changing Weather extra air scatter, then lands.
// Exported so server.js / input.js can call it after interactive phases.

function resolveKickScatter(G, nc, nr) {
    const col = nc ?? G.pendingKick?.col;
    const row = nr ?? G.pendingKick?.row;
    G.pendingKick  = null;
    G.kickoffEvent = null;

    const DC   = [ 0, 1, 1, 1, 0,-1,-1,-1];
    const DR   = [-1,-1, 0, 1, 1, 1, 0,-1];
    const DIRS = ['N','NE','E','SE','S','SW','W','NW'];

    let finalCol = col, finalRow = row;
    const parts = [];

    if (G.tripleScatterKick) {
        // Changing Weather → Perfect: 3 extra air scatters after main scatter
        G.tripleScatterKick = false;
        let extraDesc = '';
        for (let i = 0; i < 3; i++) {
            const d = Math.floor(Math.random() * 8);
            finalCol += DC[d]; finalRow += DR[d];
            extraDesc += ` +${DIRS[d]}`;
        }
        parts.push(`Ball scatters further in the air (${extraDesc.trim()}).`);
    }

    const outOfBounds  = finalCol < 0 || finalCol >= COLS || finalRow < 0 || finalRow >= ROWS;
    const inKickerHalf = !outOfBounds && isInKickerHalf(G.kicker, finalRow);

    if (outOfBounds || inKickerHalf) {
        G.ball  = { col: -1, row: -1, carrier: null };
        G.phase = 'kickoff_touchback';
        parts.push('Ball out of play — TOUCHBACK!');
        return parts.join(' ');
    }

    G.ball = { col: finalCol, row: finalRow, carrier: null };
    parts.push(`Lands at ${sqLabel(finalCol, finalRow)}.`);

    if (G.highKick) {
        G.highKick = false;
        // Only enter the High Kick prompt if the landing square is empty —
        // you can't place a player onto an occupied square. If somebody's
        // already there, fall through to the normal catch attempt.
        if (!G.players.some(p => p.col === finalCol && p.row === finalRow)) {
            G.phase = 'kickoff_highkick';
            parts.push(`[[skill:High Kick!]] ${G.receiver.toUpperCase()} may place a player here before the catch.`);
            return parts.join(' ');
        }
        parts.push(`[[skill:High Kick!]] Square already occupied — no placement.`);
    }

    const catchMsg = _resolveKickCatch(G, finalCol, finalRow);
    if (catchMsg) parts.push(catchMsg.trim());
    return parts.join(' ');
}

// Try to catch the ball at (nc, nr) and transition to play.
// Always called from kickoff context — if scatter goes OOB it's a touchback,
// not a throw-in.
function _resolveKickCatch(G, nc, nr) {
    let msg = '';
    const lander = playerAt(G, nc, nr);
    if (lander && isStanding(lander)) {
        const tzs    = countTackleZones(G, lander.side, nc, nr);
        const target = Math.min(lander.ag + tzs, 6);
        const roll   = d6();
        if (roll >= target || roll === 6) {
            lander.hasBall = true;
            G.ball.carrier = lander;
            msg += ` ${pn(lander)} catches the kick! (${roll} vs ${target}+)`;
        } else {
            msg += ` ${pn(lander)} fails to catch (${roll} vs ${target}+). ` + scatterBall(G, true);
            if (G.phase === 'kickoff_touchback') return msg;
        }
    }
    G.phase  = 'play';
    G.active = G.receiver;
    return msg;
}

// ── Kick mechanics ────────────────────────────────────────────────

// Kicker picks an aim square.
// Step 1: main scatter dice rolled (ball launched).
// Step 2: kickoff event rolled while ball is in the air.
// Step 3: ball lands (may be deferred for interactive events).
function declareKick(G, col, row) {
    if (G.phase !== 'kick') return null;
    if (!isValidKickTarget(G.kicker, col, row)) return null;

    // Step 1: roll main scatter
    const DC   = [ 0, 1, 1, 1, 0,-1,-1,-1];
    const DR   = [-1,-1, 0, 1, 1, 1, 0,-1];
    const DIRS = ['N','NE','E','SE','S','SW','W','NW'];
    const d6a  = d6(), d6b = d6();
    const dist = Math.min(d6a, d6b);
    const dir  = Math.floor(Math.random() * 8);
    const sc   = col + DC[dir] * dist;
    const sr   = row + DR[dir] * dist;
    const parts = [`Kick aimed ${sqLabel(col, row)}: ${d6a}+${d6b} → ${dist} sq ${DIRS[dir]}.`];

    // Step 2: kickoff event (pendingKick stores the scattered position)
    parts.push(_applyKickoffEvent(G, sc, sr));

    // Interactive events: landing is deferred
    if (G.phase !== 'kick') return parts.join(' ');

    // Step 3: land the ball
    const landMsg = resolveKickScatter(G, sc, sr);
    if (landMsg) parts.push(landMsg);
    return parts.join(' ');
}

// Receiver nominates a player to receive a touchback.
function touchbackGiveBall(G, playerId) {
    if (G.phase !== 'touchback' && G.phase !== 'kickoff_touchback') return null;
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

// ── High Kick resolution ──────────────────────────────────────────

// Receiver places one standing player at the ball's landing square,
// then the catch attempt is made.
function highKickPlace(G, playerId) {
    if (G.phase !== 'kickoff_highkick') return null;
    const p = G.players.find(p => p.id === playerId);
    if (!p || p.side !== G.receiver) return null;
    if (p.status !== 'active' || p.col < 0) return null;
    // Destination must be empty — defensive check in case the client view
    // and engine state drifted between selection and dispatch.
    if (G.players.some(o => o.id !== p.id && o.col === G.ball.col && o.row === G.ball.row)) return null;

    p.col = G.ball.col;
    p.row = G.ball.row;

    return `${pn(p)} leaps to ${sqLabel(p.col, p.row)}.` + _resolveKickCatch(G, p.col, p.row);
}

// Receiver declines the High Kick — normal catch attempt for whoever
// is already at the ball square (if any).
function skipHighKick(G) {
    if (G.phase !== 'kickoff_highkick') return null;
    return `${G.receiver.toUpperCase()} declines High Kick.` + _resolveKickCatch(G, G.ball.col, G.ball.row);
}

// ── _moveTurnover / _finishMove / _checkDodge ────────────────────
// Shared move helpers — factored out so movePlayer and the reroll
// resume path share identical logic without duplication.

if (typeof module !== 'undefined') {
    module.exports = { KICKOFF_EVENTS, _applyKickoffEvent, resolveKickScatter, _resolveKickCatch, declareKick, touchbackGiveBall, highKickPlace, skipHighKick };
}

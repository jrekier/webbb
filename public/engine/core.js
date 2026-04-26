// core.js
// Core game state: creation, activation, turn management.
// Also: coin toss and pre-game formation setup.
// No DOM, no canvas. Works identically in browser and Node.js.

if (typeof module !== 'undefined') {
    var { COLS, ROWS, TURNS,
          playerAt, isStanding, isAdjacent, inTackleZoneOf, countTackleZones,
          hasMovedYet, canStillCancel,
          isValidSetupSquare } = require('./helpers.js');
}

// ── createInitialState ────────────────────────────────────────────

function createInitialState() {
    return {
        phase:              'toss',   // 'toss' | 'setup' | 'play' | 'gameover'
        tossWinner:         null,
        kicker:             null,
        receiver:           null,
        firstHalfReceiver:  null,  // who received in half 1 — kicks off in half 2
        setupSide:          null,
        active:             'home',
        turn:               1,
        half:               1,
        score:              { home: 0, away: 0 },
        activated:          null,
        sel:                null,
        block:              null,
        blitz:              null,
        hasBlitzed:         false,
        hasPassed:          false,
        hasHandedOff:       false,
        hasFouled:          false,
        hasThrownMate:      false,
        fouling:            false,
        argueCallPending:   null,
        coachEjected:       { home: false, away: false },
        handingOff:         false,
        hasDodged:          false,
        asRolled:           false,
        blitzFromProne:     false,
        securingBall:       false,
        stoodUpFromProne:   false,
        passing:            false,
        hasPassReroll:      false,
        passRerollChoice:   null,
        interceptionChoice: null,
        throwTeamMate:      null,
        animalSavagery:     null,
        targeting:          null,
        ball:               { col: 5, row: 10, carrier: null },
        players:            [],
    };
}

// ── Activation ────────────────────────────────────────────────────

function activatePlayer(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p) return null;
    if (p.side !== G.active) return null;
    if (p.usedAction) return null;
    if (G.activated) return null;
    if (p.col < 0) return null;
    if (p.status === 'stunned' || p.status === 'ko' || p.status === 'casualty') return null;
    G.activated = p;
    G.sel       = p;
    return `${p.name} activated`;
}

function cancelActivation(G) {
    if (!G.activated) return null;
    if (!canStillCancel(G)) return null;
    const p    = G.activated;
    const name = p.name;
    if (G.stoodUpFromProne) {
        p.status   = 'prone';
        p.maLeft   = p.ma;
        p.rushLeft = 2;
        G.stoodUpFromProne = false;
    }
    if (G.blitz !== null) {
        if (G.blitzFromProne) {
            p.status = 'prone';
            p.maLeft = p.ma;
        }
        G.blitzFromProne = false;
        G.hasBlitzed     = false;
        G.blitz          = null;
    }
    G.securingBall       = false;
    G.fouling            = false;
    G.pvTargeting        = false;
    G.throwTeamMate      = null;
    G.animalSavagery     = null;
    G.targeting          = null;
    G.argueCallPending   = null;
    G.handingOff         = false;
    G.passing            = false;
    G.hasPassReroll      = false;
    G.passRerollChoice   = null;
    G.interceptionChoice = null;
    G.activated          = null;
    return `${name} — action cancelled`;
}

function endActivation(G) {
    if (!G.activated) return null;
    const name = G.activated.name;
    G.activated.usedAction = true;
    G.activated    = null;
    G.blitz              = null;
    G.stoodUpFromProne   = false;
    G.hasDodged          = false;
    G.asRolled           = false;
    G.fouling            = false;
    G.pvTargeting        = false;
    G.throwTeamMate      = null;
    G.animalSavagery     = null;
    G.targeting          = null;
    G.argueCallPending   = null;
    G.handingOff         = false;
    G.passing            = false;
    G.hasPassReroll      = false;
    G.passRerollChoice   = null;
    G.interceptionChoice = null;
    return `${name} done`;
}

function endTurn(G) {
    if (G.activated) endActivation(G);
    for (const p of G.players) {
        if (p.side === G.active) {
            p.usedAction = false;
            p.maLeft     = p.ma;
            p.rushLeft     = 2;
            if (p.status === 'stunned' && !p.stunnedThisTurn) p.status = 'prone';
        }
        p.stunnedThisTurn = false;
    }

    const justFinished = G.active;
    G.active         = G.active === 'home' ? 'away' : 'home';
    G.sel            = null;
    G.hasBlitzed     = false;
    G.hasPassed      = false;
    G.hasHandedOff   = false;
    G.hasFouled      = false;
    G.hasThrownMate  = false;
    G.hasDodged      = false;
    G.asRolled       = false;
    G.blitzFromProne = false;
    G.securingBall       = false;
    G.fouling            = false;
    G.animalSavagery     = null;
    G.targeting          = null;
    G.argueCallPending   = null;
    G.handingOff         = false;
    G.passing            = false;
    G.hasPassReroll      = false;
    G.passRerollChoice   = null;
    G.interceptionChoice = null;
    // Turn increments when the receiver becomes active again (completing a full round).
    if (G.active === G.receiver) G.turn += 1;

    // The kicker goes second, so they finish each round last.
    // Half 1 ends after both teams complete TURNS turns (kicker finishes turn TURNS).
    const firstHalfKicker = G.firstHalfReceiver === 'home' ? 'away' : 'home';
    if (G.half === 1 && justFinished === firstHalfKicker && G.turn > TURNS) {
        return startHalfTime(G);
    }
    // Half 2: receiver is firstHalfKicker, kicker is firstHalfReceiver.
    if (G.half === 2 && justFinished === G.firstHalfReceiver && G.turn > TURNS * 2) {
        return startGameOver(G);
    }

    return `Turn ${G.turn} · ${G.active.toUpperCase()}`;
}

// ── startHalfTime ────────────────────────────────────────────────
// KO roll for each KO'd player (4+ returns to dugout/reserves).
// Roles swap: half-1 receiver now kicks. Reset to setup.

function startHalfTime(G) {
    const koMsgs = [];
    for (const p of G.players) {
        if (p.status === 'ko') {
            const roll = Math.floor(Math.random() * 6) + 1;
            if (roll >= 4) {
                p.status = 'active';
                // Place off-pitch until setup positions them.
                p.col = -1; p.row = -1;
                koMsgs.push(`${p.name} recovers (rolled ${roll})`);
            } else {
                koMsgs.push(`${p.name} stays KO (rolled ${roll})`);
            }
        }
    }

    // Swap roles for second half
    G.half     = 2;
    G.turn     = TURNS + 1;
    G.kicker   = G.firstHalfReceiver;
    G.receiver = G.kicker === 'home' ? 'away' : 'home';

    // Reset available players and place them in default formation so they appear on pitch.
    // Compact indices: skip KO/casualty so there are no formation gaps.
    _placeInFormation(G.players.filter(p => p.side === 'home'), FORMATION_HOME);
    _placeInFormation(G.players.filter(p => p.side === 'away'), FORMATION_AWAY);

    G.activated          = null;
    G.sel                = null;
    G.block              = null;
    G.blitz              = null;
    G.hasBlitzed         = false;
    G.hasPassed          = false;
    G.hasHandedOff       = false;
    G.hasFouled          = false;
    G.hasThrownMate      = false;
    G.hasDodged          = false;
    G.asRolled           = false;
    G.blitzFromProne     = false;
    G.stoodUpFromProne   = false;
    G.securingBall       = false;
    G.fouling            = false;
    G.throwTeamMate      = null;
    G.animalSavagery     = null;
    G.targeting          = null;
    G.argueCallPending   = null;
    G.handingOff         = false;
    G.passRerollChoice   = null;
    G.interceptionChoice = null;
    G.ball               = { col: -1, row: -1, carrier: null };
    G.phase              = 'setup';
    G.setupSide          = G.kicker;

    const koSummary = koMsgs.length ? ` KO rolls: ${koMsgs.join(', ')}.` : '';
    return `HALF TIME!${koSummary} Half 2: ${G.kicker.toUpperCase()} kicks off — set up your team.`;
}

// ── startGameOver ────────────────────────────────────────────────

function startGameOver(G) {
    G.phase     = 'gameover';
    G.activated = null;
    G.sel       = null;
    G.block     = null;
    G.blitz     = null;
    const { home, away } = G.score || { home: 0, away: 0 };
    const result = home > away ? 'HOME wins!' : away > home ? 'AWAY wins!' : 'Draw!';
    return `FULL TIME! ${result} Final score: ${home}–${away}`;
}

// ── fixReferences ─────────────────────────────────────────────────
// After a JSON round-trip, G.activated / G.sel / ball.carrier become
// plain copies. Re-connect them to the live player objects by id.

function fixReferences(G) {
    if (G.activated) {
        G.activated = G.players.find(p => p.id === G.activated.id) || null;
    }
    if (G.sel) {
        G.sel = G.players.find(p => p.id === G.sel.id) || null;
    }
    if (G.ball && G.ball.carrier) {
        G.ball.carrier = G.players.find(p => p.id === G.ball.carrier.id) || null;
    }
    if (G.block && G.block.att) {
        G.block.att = G.players.find(p => p.id === G.block.att.id) || null;
        if (G.block.def)
            G.block.def = G.players.find(p => p.id === G.block.def.id) || null;
    }
    if (G.blitz && G.blitz.att) {
        G.blitz.att = G.players.find(p => p.id === G.blitz.att.id) || null;
        if (G.blitz.def)
            G.blitz.def = G.players.find(p => p.id === G.blitz.def.id) || null;
    }
}

// ── Formations ───────────────────────────────────────────────────

var FORMATION_HOME = [
    [4,13],[5,13],[6,13],
    [1,13],[9,13],
    [4,15],[6,15],
];

var FORMATION_AWAY = [
    [4,6],[5,6],[6,6],
    [1,6],[9,6],
    [4,4],[6,4],
];

function initFormations() {
    if (typeof module !== 'undefined') {
        module.exports.FORMATION_HOME = FORMATION_HOME;
        module.exports.FORMATION_AWAY = FORMATION_AWAY;
    }
}

// ── _placeInFormation ─────────────────────────────────────────────
// Places available (non-KO, non-casualty) players into formation slots,
// compacting indices so missing players don't leave gaps.
// KO/casualty players are moved off-pitch.

function _placeInFormation(players, formation) {
    let fi = 0;
    for (const p of players) {
        if (p.status === 'ko' || p.status === 'casualty') {
            p.col = -1; p.row = -1;
            continue;
        }
        p.status     = 'active';
        p.hasBall    = false;
        p.maLeft     = p.ma;
        p.rushLeft   = 2;
        p.usedAction = false;
        if (fi < formation.length) {
            const [col, row] = formation[fi++];
            p.col = col;
            p.row = row;
        } else {
            // More available players than formation slots: goes to reserve
            p.col = -1; p.row = -1;
        }
    }
}

// ── resetAfterTouchdown ───────────────────────────────────────────
// Resets all players to their formation positions and returns the
// ball to the centre. The team that did NOT score goes next (they
// receive the kickoff from the scoring team).

function resetAfterTouchdown(G, scoringSide) {
    // KO recovery roll (4+) before resetting positions
    const koMsgs = [];
    for (const p of G.players) {
        if (p.status === 'ko') {
            const roll = Math.floor(Math.random() * 6) + 1;
            if (roll >= 4) {
                p.status = 'active';
                koMsgs.push(`${p.name} recovers (rolled ${roll})`);
            } else {
                koMsgs.push(`${p.name} stays KO (rolled ${roll})`);
            }
        }
    }
    if (koMsgs.length) G._koRollMsg = koMsgs.join(', ');

    _placeInFormation(G.players.filter(p => p.side === 'home'), FORMATION_HOME);
    _placeInFormation(G.players.filter(p => p.side === 'away'), FORMATION_AWAY);

    G.activated          = null;
    G.sel                = null;
    G.block              = null;
    G.blitz              = null;
    G.hasBlitzed         = false;
    G.hasPassed          = false;
    G.hasHandedOff       = false;
    G.hasFouled          = false;
    G.hasThrownMate      = false;
    G.hasDodged          = false;
    G.asRolled           = false;
    G.blitzFromProne     = false;
    G.stoodUpFromProne   = false;
    G.securingBall       = false;
    G.fouling            = false;
    G.throwTeamMate      = null;
    G.animalSavagery     = null;
    G.targeting          = null;
    G.argueCallPending   = null;
    G.passRerollChoice   = null;
    G.interceptionChoice = null;

    // Scoring team kicks off the next drive; both sides set up again
    G.kicker    = scoringSide;
    G.receiver  = scoringSide === 'home' ? 'away' : 'home';
    G.phase     = 'setup';
    G.setupSide = G.kicker;
}

// ── setup ─────────────────────────────────────────────────────────
// Coin toss and pre-game formation setup.
// Sevens setup rules:
//   Home sets up on rows 13–19, away on rows 0–6.
//   ≥3 players on the LoS (row 13 / row 6).
//   ≤2 players per wide zone (cols 0–1, cols 9–10).

// ── initToss ──────────────────────────────────────────────────────
// Picks a random toss winner. Returns the winning side.

function initToss(G) {
    G.phase      = 'toss';
    G.tossWinner = Math.random() < 0.5 ? 'home' : 'away';
    return G.tossWinner;
}

// ── chooseTossResult ──────────────────────────────────────────────
// Called when the toss winner picks 'kick' or 'receive'.
// Transitions to setup phase with the kicker setting up first.

function chooseTossResult(G, choice) {
    G.kicker             = choice === 'kick'
        ? G.tossWinner
        : (G.tossWinner === 'home' ? 'away' : 'home');
    G.receiver           = G.kicker === 'home' ? 'away' : 'home';
    G.firstHalfReceiver  = G.receiver;
    G.phase              = 'setup';
    G.setupSide          = G.kicker;
    return `${G.kicker.toUpperCase()} kicks off — set up your team.`;
}

// ── moveSetupPlayer ───────────────────────────────────────────────
// Drag a player to a new square during the setup phase.

function moveSetupPlayer(G, playerId, col, row) {
    if (G.phase !== 'setup') return null;
    const p = G.players.find(p => p.id === playerId);
    if (!p || p.side !== G.setupSide) return null;
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
    if (!isValidSetupSquare(p.side, col, row)) return null;
    if (G.players.some(o => o.id !== playerId && o.col === col && o.row === row)) return null;
    p.col = col;
    p.row = row;
    return 'ok';
}

// ── validateSetup ─────────────────────────────────────────────────
// Returns an array of rule violation strings. Empty = valid.

function validateSetup(G, side) {
    const players   = G.players.filter(p => p.side === side);
    const errors    = [];
    const losRow    = side === 'home' ? 13 : 6;
    const available = players.filter(p => p.status !== 'ko' && p.status !== 'casualty');
    const onPitch   = available.filter(p => p.col >= 0);
    const mustField = Math.min(available.length, 7);

    if (onPitch.length < mustField)
        errors.push(`You must field all ${mustField} available players.`);
    if (onPitch.length > 7)
        errors.push('You cannot have more than 7 players on the pitch.');
    if (onPitch.filter(p => p.row === losRow).length < 3)
        errors.push('At least 3 players must be on the line of scrimmage.');
    if (onPitch.filter(p => p.col <= 1).length > 2)
        errors.push('Max 2 players in the left wide zone (cols 0–1).');
    if (onPitch.filter(p => p.col >= 9).length > 2)
        errors.push('Max 2 players in the right wide zone (cols 9–10).');

    return errors;
}

// ── confirmSetup ──────────────────────────────────────────────────
// Lock in the current side's formation.
// Returns { ok, msg } or { errors }.

function confirmSetup(G, side) {
    if (G.phase !== 'setup' || G.setupSide !== side) return null;
    const errors = validateSetup(G, side);
    if (errors.length > 0) return { errors };

    if (side === G.kicker) {
        G.setupSide = G.receiver;
        return { ok: true, msg: `${G.receiver.toUpperCase()} — set up your team.` };
    }

    // Both sides confirmed — hand off to kick phase
    G.phase     = 'kick';
    G.setupSide = null;
    G.ball      = { col: -1, row: -1, carrier: null };  // off-pitch until kicked
    return { ok: true, msg: `${G.kicker.toUpperCase()} kicks off — click where to aim.` };
}

// ── demoteToReserve ───────────────────────────────────────────────
// Moves an on-pitch player back to reserve (col=-1) during setup.

function demoteToReserve(G, playerId) {
    if (G.phase !== 'setup') return null;
    const p = G.players.find(p => p.id === playerId);
    if (!p || p.side !== G.setupSide) return null;
    if (p.status === 'ko' || p.status === 'casualty') return null;
    if (p.col < 0) return null;  // already in reserve
    p.col = -1;
    p.row = -1;
    return 'ok';
}

// ── swapSetupPlayers ──────────────────────────────────────────────
// During setup, swaps positions of any two same-side players.
// Works for reserve↔pitch, pitch↔pitch, and reserve↔reserve.

function swapSetupPlayers(G, id1, id2) {
    if (G.phase !== 'setup') return null;
    const p1 = G.players.find(p => p.id === id1);
    const p2 = G.players.find(p => p.id === id2);
    if (!p1 || !p2) return null;
    if (p1.side !== G.setupSide || p2.side !== G.setupSide) return null;
    const c1 = p1.col, r1 = p1.row;
    p1.col = p2.col; p1.row = p2.row;
    p2.col = c1;     p2.row = r1;
    return 'ok';
}

// ── swapReservePlayer ─────────────────────────────────────────────
// During setup phase, exchanges a reserve player (col=-1) with an
// on-pitch player of the same side. Used to choose who sits out when
// a team has more than 7 available players.

function swapReservePlayer(G, reserveId, pitchId) {
    if (G.phase !== 'setup') return null;
    const reserve = G.players.find(p => p.id === reserveId);
    const pitcher = G.players.find(p => p.id === pitchId);
    if (!reserve || !pitcher) return null;
    if (reserve.side !== G.setupSide || pitcher.side !== G.setupSide) return null;
    if (reserve.col >= 0) return null;  // not actually in reserve
    if (pitcher.col < 0)  return null;  // not actually on pitch
    const col = pitcher.col;
    const row = pitcher.row;
    pitcher.col = -1; pitcher.row = -1;
    reserve.col = col; reserve.row = row;
    return 'ok';
}

if (typeof module !== 'undefined') {
    module.exports = {
        createInitialState,
        activatePlayer, cancelActivation, endActivation, endTurn,
        fixReferences,
        FORMATION_HOME, FORMATION_AWAY, initFormations,
        resetAfterTouchdown, startHalfTime, startGameOver,
        initToss, chooseTossResult,
        moveSetupPlayer, demoteToReserve, swapReservePlayer, swapSetupPlayers, validateSetup, confirmSetup,
    };
}

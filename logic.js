// logic.js
// Pure game logic — no DOM, no canvas, no rendering, no globals.
// G is passed explicitly to every function.
// This file works identically in the browser and on Node.js.

// ── Initial state ─────────────────────────────────────────────────
// Returns a fresh G object. Called at game start.

function createInitialState() {
    return {
        active:      'home',
        turn:        1,
        half:        1,
        homeScore:   0,
        awayScore:   0,
        activated:   null,
        sel:         null,
        block:       null,
        blitz:       null,
        hasBlitzed:  false,
        hasDodged:   false,
        ball:        { col: 7, row: 13, carrier: null },
        players:     [],
    };
}

// ── Queries ───────────────────────────────────────────────────────
// These just look things up — they never modify G.

function playerAt(G, col, row) {
    return G.players.find(p => p.col === col && p.row === row) || null;
}

function canMoveTo(G, player, col, row) {
    const dc = Math.abs(player.col - col);
    const dr = Math.abs(player.row - row);
    const minMA  = player.status === 'prone' ? 3 : 1;   // stand-up costs 3 total
    const allowed = (dc <= 1 && dr <= 1 && !(dc === 0 && dr === 0)
        && player.maLeft + player.rushLeft >= minMA
        && playerAt(G, col, row) === null);
    let needsrush = (player.maLeft === 0);
    if (player.status === 'prone') {
        needsrush = (player.maLeft < 3);   // need rush rolls to cover stand-up shortfall
    }

    // Dodge required if leaving a tackle zone
    const needsDodge = G.players.some(enemy =>
        enemy.side !== player.side && isStanding(enemy) && isAdjacent(player, enemy)
    );
    
    let dodgerolltarget = 0;
    if (needsDodge) {
        // Target: player's AG + 1, +1 per tackle zone covering the destination.
        const destTZs = G.players.filter(enemy =>
            enemy.side !== player.side
            && isStanding(enemy)
            && Math.abs(enemy.col - col) <= 1
            && Math.abs(enemy.row - row) <= 1
            && !(enemy.col === col && enemy.row === row)
        ).length;
        dodgerolltarget = Math.min(player.ag + destTZs, 6);
    }

    return { allowed, needsrush, dodgerolltarget }
}

function hasMovedYet(G) {
    if (!G.activated) return false;
    return G.activated.maLeft < G.activated.ma;
}

// True when cancellation is still legal: player activated but not yet taken a real step.
// A prone blitzer standing up doesn't count as having moved yet.
function canStillCancel(G) {
    if (!G.activated) return false;
    return !hasMovedYet(G) || G.blitzFromProne;
}

// ── Actions ───────────────────────────────────────────────────────
// These modify G. Each one does one thing and nothing else.

function activatePlayer(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p) return null;
    if (p.side !== G.active) return null;
    if (p.usedAction) return null;
    if (G.activated) return null;
    if (p.status === 'stunned') return null;   // stunned players can't act at all
    G.activated = p;
    G.sel       = p;
    return `${p.pos} activated`;
}

function cancelActivation(G) {
    if (!G.activated) return null;
    if (!canStillCancel(G)) return null;
    const p    = G.activated;
    const name = p.pos;
    if (G.blitz !== null) {
        if (G.blitzFromProne) {
            p.status = 'prone';
            p.maLeft = p.ma;
        }
        G.blitzFromProne = false;
        G.hasBlitzed     = false;
        G.blitz          = null;
    }
    G.securingBall = false;
    G.activated    = null;
    return `${name} — action cancelled`;
}

function movePlayer(G, col, row) {
    if (!G.activated) return null;
    const { allowed, needsrush, dodgerolltarget } = canMoveTo(G, G.activated, col, row);
    if (!allowed) return null;

    const p = G.activated;
    let msg = '';
    let standingUp = false;

    // Stand up from prone — costs 3 MA; rush rolls cover any shortfall (1 per missing MA)
    if (p.status === 'prone') {
        standingUp = true;
        const rushesNeeded = Math.max(0, 3 - p.maLeft);
        for (let i = 0; i < rushesNeeded; i++) {
            const { roll, failed } = rush();
            if (failed) {
                msg += `${p.pos} fails to stand (rolled ${roll}). `;
                p.col = col;
                p.row = row;
                msg += knockDown(G, p);
                endTurn(G);
                return msg + ' TURNOVER';
            }
            msg += `${p.pos} rushes to stand (rolled ${roll}). `;
        }
        p.rushLeft -= rushesNeeded;
        p.maLeft    = 0;
        p.status    = 'active';
    }

    // Rush required for regular movement (only when already standing)
    if (!standingUp && needsrush) {
        const { roll: rushroll, failed: rushFailed } = rush();
        if (rushFailed) {
            msg += `${p.pos} fails rush (rolled ${rushroll}). `;
            p.col = col;
            p.row = row;
            msg += knockDown(G, p);
            endTurn(G);
            return msg;
        }
        msg += `${p.pos} rushes (rolled ${rushroll}). `;
    }

    // Dodge required
    const needsDodge = (dodgerolltarget !== 0);

    // Tackle negates Dodge skill
    const markedbyTackle = G.players.some(enemy =>
        enemy.side !== p.side && isStanding(enemy) && isAdjacent(p, enemy) && enemy.skills?.includes('Tackle')
    );    

    if (needsDodge) {
        let { roll, target, failed } = dodge(dodgerolltarget);
        if (!failed) {
            msg += `${p.pos} dodges (rolled ${roll}, needed ${target}+). `;
        } 
        else {
            // First failure
            if (p.skills && p.skills.includes('Dodge') && !G.hasDodged && !markedbyTackle) {
                msg += `${p.pos} fails dodge (rolled ${roll}, needed ${target}+). Uses Dodge skill. `;
                G.hasDodged = true;

                ({ roll, target, failed } = dodge(dodgerolltarget));
                if (!failed) {
                    msg += `${p.pos} succeeds dodge on reroll (rolled ${roll}, needed ${target}+). `;
                }
            }            
            // Final failure check (covers BOTH: no skill + failed reroll)
            if (failed) {
                msg += `${p.pos} fails dodge (rolled ${roll}, needed ${target}+). `;
                p.col = col; // falls over on target square
                p.row = row;
                msg += knockDown(G, p);
                endTurn(G);
                return msg + ' TURNOVER'
            }
        }
    }

    p.col = col;
    p.row = row;
    if (!standingUp) {
        if (!needsrush) {
            p.maLeft -= 1;
        } else {
            p.rushLeft -= 1;
        }
    }
    // standingUp: the 3 MA stand-up cost already covers this first step
    G.sel = p;
    if (p.maLeft + p.rushLeft === 0) endActivation(G);

    // Ball pickup (player stepped onto loose ball)
    let pickupMsg;
    if (G.securingBall && p.col === G.ball.col && p.row === G.ball.row) {
        pickupMsg = _doSecureRoll(G, p);
    } else {
        pickupMsg = tryPickup(G, p);
    }
    if (pickupMsg) {
        msg += ' ' + pickupMsg;
        if (pickupMsg.includes('TURNOVER')) return msg;
    }

    // Touchdown check
    const tdMsg = checkTouchdown(G, p);
    if (tdMsg) return msg + ' ' + tdMsg;

    return msg;
}


function endActivation(G) {
    if (!G.activated) return null;
    const name = G.activated.pos;
    G.activated.usedAction = true;
    G.activated = null;
    G.blitz     = null;
    G.hasDodged = false;
    return `${name} done`;
}

function endTurn(G) {
    if (G.activated) endActivation(G);
    for (const p of G.players) {
        if (p.side === G.active) {
            p.usedAction = false;
            p.maLeft     = p.ma;
            p.rushLeft   = 2;
            // Stunned players flip face-up at the end of their own team's turn
            if (p.status === 'stunned') p.status = 'prone';
        }
    }
    G.active         = G.active === 'home' ? 'away' : 'home';
    G.sel            = null;
    G.hasBlitzed     = false;
    G.hasDodged      = false;
    G.blitzFromProne = false;
    G.securingBall   = false;
    if (G.active === 'home') G.turn += 1;
    return `Turn ${G.turn} · ${G.active.toUpperCase()}`;
}

// ── Fix references after JSON round-trip ─────────────────────────
// When G is serialised to JSON and back, G.activated and G.sel
// become plain copies — no longer the same object as the player
// in G.players. This re-connects them by id.

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
    // Reconnect block att/def references lost during JSON serialisation
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

// ── Formation positions ──────────────────────────────────────────
// Indexed by ruleset name so classic and 7s both work.
// FORMATION_HOME/AWAY are set at game start based on active ruleset.

var FORMATIONS = {
    sevens: {
        // LoS is the boundary between rows 7/8 (away) and 12/13 (home).
        // Players set up ON their LoS row — home on row 13, away on row 7.
        // Wide zone players must be in cols 0-1 or 9-10.
        home: [
            [4,13],[5,13],[6,13],   // 3 on LoS (row 13)
            [1,13],[9,13],          // 1 in each wide zone, also on LoS
            // [4,15],[6,15],          // 2 behind line
            [4,15],[7,7],          // 2 behind line
        ],
        away: [
            [4,6],[5,6],[6,6],      // 3 on LoS (row 6)
            [1,6],[9,6],            // 1 in each wide zone, also on LoS
            [4,4],[6,4],            // 2 behind line
        ],
    },
    classic: {
        home: [
            [5,13],[7,13],[9,13],
            [3,15],[11,15],
            [5,16],[7,16],[9,16],
            [4,17],[7,17],[10,17],
        ],
        away: [
            [5,12],[7,12],[9,12],
            [3,10],[11,10],
            [5,9],[7,9],[9,9],
            [4,8],[7,8],[10,8],
        ],
    },
};

// Active formations — set by initFormations() based on RULESET
var FORMATION_HOME = [];
var FORMATION_AWAY = [];

// key is 'sevens' or 'classic'. In the browser, called with no args
// and falls back to RULESET. On the server, called with explicit key.
function initFormations(key) {
    if (!key) {
        // browser: derive from global RULESET
        key = (RULESET === RULESETS.sevens) ? 'sevens' : 'classic';
    }
    FORMATION_HOME = FORMATIONS[key].home;
    FORMATION_AWAY = FORMATIONS[key].away;
    // Update exports so server sees the new values
    if (typeof module !== 'undefined') {
        module.exports.FORMATION_HOME = FORMATION_HOME;
        module.exports.FORMATION_AWAY = FORMATION_AWAY;
    }
}

// ── Node.js export ────────────────────────────────────────────────
// In the browser these functions are globals — nothing to do.
// In Node.js we must export them so server.js can require() this file.
// The typeof check makes this work in both environments.

if (typeof module !== 'undefined') {
    module.exports = {
        FORMATION_HOME, FORMATION_AWAY, FORMATIONS, initFormations,
        createInitialState,
        playerAt, canMoveTo, hasMovedYet, canStillCancel, fixReferences,
        secureBall, scatterBall, tryPickup, checkTouchdown,
        activatePlayer, cancelActivation,
        movePlayer, endActivation,
        endTurn,
        isAdjacent, isStanding, inTackleZoneOf,
        countAssists, blockDiceCount, getBlockTargets,
        BLOCK_FACES, rollBlockDice, getPushSquares,
        declareBlock, pickBlockFace, pickPushSquare, resolveFollowUp, knockDown,
        activateBlitz, setBlitzTarget, blitzBlock,
        dodge, rush, standUp,
    };
}


// ═══════════════════════════════════════════════════════════════
//  TACKLE ZONES & ASSISTS
// ═══════════════════════════════════════════════════════════════

// ── isAdjacent ───────────────────────────────────────────────────
// Returns true if two players are in adjacent squares.
// Used everywhere — blocking, assists, dodge checks.

function isAdjacent(a, b) {
    return Math.abs(a.col - b.col) <= 1
        && Math.abs(a.row - b.row) <= 1
        && !(a.col === b.col && a.row === b.row);
}

// ── isStanding ───────────────────────────────────────────────────
// A player only exerts a tackle zone if they are upright and on the pitch.

function isStanding(p) {
    return p.col >= 0 && p.status === 'active';
}

// ── inTackleZoneOf ───────────────────────────────────────────────
// Returns true if player 'p' is in the tackle zone of player 'threat'.
// i.e. threat is standing, adjacent, and on the opposing side.

function inTackleZoneOf(p, threat) {
    return isStanding(threat) && isAdjacent(p, threat);
}

// ── countAssists ─────────────────────────────────────────────────
// Returns the effective strength of each side after counting assists.
//
// An assist is a standing friendly player who:
//   1. Is adjacent to the target (in their tackle zone)
//   2. Is NOT adjacent to any enemy other than the target
//      (they can't assist if they're being marked by someone else)

function countAssists(G, att, def) {
    const friends = (side) => G.players.filter(p =>
        p.side === side && isStanding(p) && p.id !== att.id && p.id !== def.id
    );

    // Count assists for the attacker:
    // friendly players adjacent to the defender, not marked by any enemy except att
    const attAssists = friends(att.side).filter(helper => {
        if (!isAdjacent(helper, def)) return false;
        const markedByEnemy = G.players.some(enemy =>
            enemy.side === def.side
            && isStanding(enemy)
            && enemy.id !== def.id
            && isAdjacent(helper, enemy)
        );
        return !markedByEnemy;
    }).length;

    // Count assists for the defender:
    // friendly players adjacent to the attacker, not marked by any enemy except def
    const defAssists = friends(def.side).filter(helper => {
        if (!isAdjacent(helper, att)) return false;
        const markedByEnemy = G.players.some(enemy =>
            enemy.side === att.side
            && isStanding(enemy)
            && enemy.id !== att.id
            && isAdjacent(helper, enemy)
        );
        return !markedByEnemy;
    }).length;

    return {
        attStr: att.st + attAssists,
        defStr: def.st + defAssists,
        attAssists,
        defAssists,
    };
}

// ── blockDiceCount ───────────────────────────────────────────────
// Returns { dice, chooser } based on the strength comparison.
// chooser is 'att' or 'def'.

function blockDiceCount(attStr, defStr) {
    if      (attStr > defStr * 2) return { dice: 3, chooser: 'att' };
    else if (defStr > attStr * 2) return { dice: 3, chooser: 'def' };
    else if (attStr > defStr)     return { dice: 2, chooser: 'att' };
    else if (defStr > attStr)     return { dice: 2, chooser: 'def' };
    else                          return { dice: 1, chooser: 'att' };
}

// ── getBlockTargets ──────────────────────────────────────────────
// Returns all enemy players that the given player can block:
// adjacent, standing enemies.

function getBlockTargets(G, att) {
    return G.players.filter(p =>
        p.side !== att.side
        && isStanding(p)
        && isAdjacent(att, p)
    );
}

// Export new functions


// ═══════════════════════════════════════════════════════════════
//  BLOCK DICE
// ═══════════════════════════════════════════════════════════════

// The six faces of the block die.
// Each has an id (used in logic), a label (shown in UI), and a css class.

var BLOCK_FACES = [
    { id: 'ATT_DOWN',      label: 'Attacker\nDown',     cls: 'bad'  },
    { id: 'BOTH_DOWN',     label: 'Both\nDown',          cls: 'skull'},
    { id: 'PUSH',          label: 'Push',                cls: ''     },
    { id: 'PUSH',          label: 'Push',                cls: ''     },
    { id: 'DEF_STUMBLES',  label: 'Defender\nStumbles',  cls: 'good' },
    { id: 'DEF_DOWN',      label: 'Defender\nDown',      cls: 'good' },
];

// ── rollBlockDice ─────────────────────────────────────────────────
// Rolls n block dice and returns the face results.

function rollBlockDice(n) {
    const results = [];
    for (let i = 0; i < n; i++) {
        const idx = Math.floor(Math.random() * BLOCK_FACES.length);
        results.push(BLOCK_FACES[idx]);
    }
    return results;
}

// ── getPushSquares ────────────────────────────────────────────────
// Returns the valid squares the defender can be pushed into.
// The push arc is the 3 squares "behind" the defender relative
// to the attacker's direction. If those are occupied or off-pitch,
// we fall back to any free adjacent square.

function getPushSquares(G, att, def) {
    const dc = Math.sign(def.col - att.col);
    const dr = Math.sign(def.row - att.row);

    // The push arc is always exactly 3 squares: those behind the defender
    // relative to the attacker. A neighbour direction (sc,sr) is valid if:
    //   - it doesn't oppose either component of the push direction
    //   - for straight attacks, at least one component must align with push dir
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

    // Filter to in-bounds, unoccupied squares
    const free = candidates.filter(([c, r]) =>
        c >= 0 && c < COLS && r >= 0 && r < ROWS && !playerAt(G, c, r)
    );

    // If all are occupied (chain push), return occupied squares too
    return free.length > 0 ? free : candidates.filter(([c, r]) =>
        c >= 0 && c < COLS && r >= 0 && r < ROWS
    );
}



// ═══════════════════════════════════════════════════════════════
//  BLOCK RESOLUTION
// ═══════════════════════════════════════════════════════════════

// ── declareBlock ─────────────────────────────────────────────────
// Called when the player clicks Block then clicks a target.
// Rolls the dice and sets G.block with phase 'pick-face'.

function declareBlock(G, att, def) {
    const { attStr, defStr } = countAssists(G, att, def);
    const { dice, chooser } = blockDiceCount(attStr, defStr);
    const rolls = rollBlockDice(dice);

    G.block = {
        att,
        def,
        rolls,
        chooser,
        phase: 'pick-face',
        chosenFace:  null,
        pushSquares: null,
    };

    return `${att.pos} (ST${attStr}) blocks ${def.pos} (ST${defStr}) · ${dice}d`;
}

// ── pickBlockFace ─────────────────────────────────────────────────
// Called when the user picks a face from the dice overlay.
// Applies the result and transitions to 'pick-push' or resolves immediately.

function pickBlockFace(G, face) {
    const { att, def } = G.block;
    G.block.chosenFace = face;

    switch (face.id) {

        case 'ATT_DOWN': {
            const injMsg = knockDown(G, att);
            G.block = null;
            G.blitz = null;
            G.activated = null;
            att.usedAction = true;
            endTurn(G);
            return `${att.pos} is knocked down! ${injMsg} TURNOVER`;
        }

        case 'BOTH_DOWN': {
            const attHasBlock = att.skills?.includes('Block');
            const defHasBlock = def.skills?.includes('Block');
            const attInj = attHasBlock ? null : knockDown(G, att);
            const defInj = defHasBlock ? null : knockDown(G, def, { attacker: att });
            G.block = null;
            G.blitz = null;
            att.usedAction = true;
            if (attHasBlock) {
                G.activated = null;
                if (defHasBlock) return `Both keep their footing (Block).`;
                return `${def.pos} knocked down! ${defInj} ${att.pos} keeps footing (Block).`;
            }
            G.activated = null;
            endTurn(G);
            if (defHasBlock) return `${att.pos} knocked down! ${attInj} ${def.pos} keeps footing (Block). TURNOVER`;
            return `Both knocked down! ${att.pos}: ${attInj} ${def.pos}: ${defInj} TURNOVER`;
        }

        case 'PUSH':
        case 'DEF_STUMBLES':
        case 'DEF_DOWN': {
            // Need to pick a push square first
            const squares = getPushSquares(G, att, def);
            G.block.phase       = 'pick-push';
            G.block.pushSquares = squares;
            const falls = face.id !== 'PUSH';
            return `${def.pos} is pushed back${falls ? ' and falls!' : '.'}  Choose push square.`;
        }
    }
}

// ── pickPushSquare ────────────────────────────────────────────────
// Called when the attacker picks a push square.
// Moves the defender, optionally knocks them down, offers follow-up.

function pickPushSquare(G, col, row) {
    const { att, def, chosenFace } = G.block;

    // Remember defender's current position — this is the square
    // that will be vacated, which the attacker can follow up into
    const vacCol = def.col;
    const vacRow = def.row;

    // Move defender to chosen square
    def.col = col;
    def.row = row;

    let msg = `${def.pos} pushed to (${col},${row}).`;

    // Knock down if face warrants it
    if (
        // simple pow
        (chosenFace.id === 'DEF_DOWN')  
        // stumble and def has no dodge
        || (chosenFace.id === 'DEF_STUMBLES' && !def.skills?.includes('Dodge'))
        // stumble and def has dodge but att has tackle
        || (chosenFace.id === 'DEF_STUMBLES' && def.skills?.includes('Dodge') && att.skills?.includes('Tackle')) 
    ) {
        const injMsg = knockDown(G, def, { attacker: att });
        msg += ` ${def.pos} is knocked down! ${injMsg}`;
    }

    // Transition to follow-up phase
    G.block = {
        phase:  'follow-up',
        att,
        vacCol,
        vacRow,
    };

    return msg + ' Follow up?';
}

function resolveFollowUp(G, followUp) {
    if (!G.block || G.block.phase !== 'follow-up') return null;
    const { att, vacCol, vacRow } = G.block;

    if (followUp) {
        att.col = vacCol;
        att.row = vacRow;
    }

    G.block = null;

    if (G.blitz) {
        // Blitz: MA was already paid in declareBlitz. Keep player activated to move.
        G.blitz = null;
        // G.hasBlitzed = true; // Mark that we've blitzed this turn so we can't blitz again
        const maMsg = att.maLeft > 0 ? ` · ${att.maLeft} MA left` : '';
        if (att.maLeft === 0) {
            att.usedAction = true;
            G.activated    = null;
        }
        return (followUp ? `${att.pos} follows up` : `${att.pos} stays`) + maMsg;
    }

    att.usedAction = true;
    G.activated    = null;
    return followUp ? `${att.pos} follows up` : `${att.pos} stays`;
}

// ── rush ─────────────────────────────────────────────────────────
// One Go-For-It roll: roll a d6, needs 2+ to succeed.
// On failure, knocks the player down (caller handles turnover).
// Returns { roll, failed }.

function rush() {
    const roll   = Math.floor(Math.random() * 6) + 1;
    const failed = roll === 1;
    return { roll, failed };
}

// ── dodge ─────────────────────────────────────────────────────────
// Roll to leave a square that is in a tackle zone.
// A roll of 6 always succeeds.
// Returns { roll, target, failed }.

function dodge(target) {
    const roll   = Math.floor(Math.random() * 6) + 1;
    const failed = roll !== 6 && roll < target;
    return { roll, target, failed };
}

// ── standUp ──────────────────────────────────────────────────────
// Activates a prone player and attempts to stand them up.
// Costs 3 MA. If maLeft < 3 the shortfall must be covered by rush
// rolls (one per missing MA point), each stopping on the first 1.

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
        return `${p.pos} stands up · ${p.maLeft} MA left`;
    }

    // Not enough base MA — cover the gap with rush rolls
    const rolls = [];
    for (let i = 0; i < rushesNeeded; i++) {
        const { roll, failed } = rush();
        rolls.push(roll);
        if (failed) {
            const injMsg = knockDown(G, p);
            endTurn(G);
            return `${p.pos} fails to stand (rolled ${rolls.join(', ')}). ${injMsg} TURNOVER`;
        }
    }

    p.maLeft = 0;
    p.status  = 'active';
    endActivation(G);
    return `${p.pos} stands up on a rush (rolled ${rolls.join(', ')})`;
}

// ── rollArmourAndInjury ───────────────────────────────────────────
// Rolls 2d6 armour and (if broken) 2d6 injury for player p.
// attacker may have Mighty Blow; p may have Thick Skull.
// Returns { armorRoll, armorBroken, injuryRoll, outcome }.
// outcome is 'stunned' | 'ko' | 'casualty' | null (armor held).

function rollArmourAndInjury(p, attacker) {
    const d1a = Math.floor(Math.random() * 6) + 1;
    const d2a = Math.floor(Math.random() * 6) + 1;
    const rawArmor   = d1a + d2a;
    const mightyBlow = attacker?.skills?.includes('Mighty Blow') ? 1 : 0;

    // Mighty Blow: optimally apply +1 to armor (to tip a break) or save for injury
    const wouldBreakWithBonus = rawArmor + mightyBlow > p.av;
    const applyBonusToArmor  = mightyBlow > 0 && rawArmor <= p.av && wouldBreakWithBonus;
    const armorRoll          = applyBonusToArmor ? rawArmor + mightyBlow : rawArmor;
    const injuryBonus        = mightyBlow > 0 && !applyBonusToArmor ? mightyBlow : 0;

    if (armorRoll <= p.av) {
        return { armorRoll, armorBroken: false, injuryRoll: null, outcome: null };
    }

    const d1i      = Math.floor(Math.random() * 6) + 1;
    const d2i      = Math.floor(Math.random() * 6) + 1;
    const injuryRoll = d1i + d2i + injuryBonus;
    const thickSkull = p.skills?.includes('Thick Skull');

    let outcome;
    if      (injuryRoll <= 7) outcome = 'stunned';
    else if (injuryRoll <= 9) outcome = thickSkull ? 'stunned' : 'ko';
    else                      outcome = 'casualty';

    return { armorRoll, armorBroken: true, injuryRoll, outcome };
}

// ── secureBall ────────────────────────────────────────────────────
// Secure the Ball action (BB2025): roll 2+, pick up the loose ball,
// activation ends. No movement required; player must be on the ball.

// ── _doSecureRoll ─────────────────────────────────────────────────
// Rolls 2+ for Secure the Ball. Called once the player is on the
// ball's square. Ends activation on success; turnover on failure.

function _doSecureRoll(G, p) {
    const tzs    = _countTackleZones(G, p.side, G.ball.col, G.ball.row);
    const target = Math.min(2 + tzs, 6);
    const roll   = Math.floor(Math.random() * 6) + 1;
    G.securingBall = false;
    if (roll >= target || roll === 6) {
        p.hasBall      = true;
        G.ball.carrier = p;
        endActivation(G);
        return `${p.pos} secures the ball (rolled ${roll}, needed ${target}+).`;
    }
    const scatterMsg = scatterBall(G);
    endTurn(G);
    return `${p.pos} fails to secure (rolled ${roll}). ${scatterMsg} TURNOVER`;
}

// ── secureBall ────────────────────────────────────────────────────
// Secure the Ball action (BB2025): activates player in securing mode.
// If already on the ball, rolls immediately. Otherwise the player
// moves normally and the 2+ fires when they step onto the ball square.

function secureBall(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p || p.side !== G.active || p.usedAction || G.activated) return null;
    if (p.status !== 'active') return null;
    if (G.ball.carrier) return null;

    // Already on the ball square — resolve immediately
    if (p.col === G.ball.col && p.row === G.ball.row) {
        return _doSecureRoll(G, p);
    }

    // Activate player; 2+ roll fires in movePlayer when they reach the ball
    G.activated    = p;
    G.sel          = p;
    G.securingBall = true;
    return `${p.pos} declares Secure Ball — move to the ball.`;
}

// ── scatterBall ───────────────────────────────────────────────────
// Moves the loose ball one square in a random d8 direction.
// If it lands on a standing player they attempt to catch it (AG roll).
// Repeats if it lands on a prone/stunned player (ball bounces off).
// Returns a log string.

// ── _countTackleZones ─────────────────────────────────────────────
// Count opposing standing players whose tackle zone covers (col, row).

function _countTackleZones(G, side, col, row) {
    return G.players.filter(e =>
        e.side !== side && isStanding(e)
        && Math.abs(e.col - col) <= 1 && Math.abs(e.row - row) <= 1
        && !(e.col === col && e.row === row)
    ).length;
}

// ── scatterBall ───────────────────────────────────────────────────
// Moves the loose ball one square in a random d8 direction.
// Standing players on the landing square attempt a catch (AG + TZs).
// Prone/stunned players let the ball rest on their square.

function scatterBall(G) {
    const DC = [ 0, 1, 1, 1, 0,-1,-1,-1];
    const DR = [-1,-1, 0, 1, 1, 1, 0,-1];
    const dir = Math.floor(Math.random() * 8);
    const nc  = G.ball.col + DC[dir];
    const nr  = G.ball.row + DR[dir];

    // Out of bounds — clamp to nearest edge square
    if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) {
        G.ball.col = Math.max(0, Math.min(COLS - 1, nc < 0 ? 0 : nc >= COLS ? COLS - 1 : nc));
        G.ball.row = Math.max(0, Math.min(ROWS - 1, nr < 0 ? 0 : nr >= ROWS ? ROWS - 1 : nr));
        return `Ball scattered out of bounds — placed at (${G.ball.col},${G.ball.row}).`;
    }

    G.ball.col = nc;
    G.ball.row = nr;

    const lander = playerAt(G, nc, nr);

    // Empty square — ball rests here
    if (!lander) return `Ball scattered to (${nc},${nr}).`;

    // Prone/stunned player — ball bounces off and scatters again
    if (!isStanding(lander)) {
        return `Ball bounces off ${lander.pos}. ` + scatterBall(G);
    }

    // Standing player — attempt catch: AG + tackle zones on that square
    const tzs    = _countTackleZones(G, lander.side, nc, nr);
    const target = Math.min(lander.ag + tzs, 6);
    const roll   = Math.floor(Math.random() * 6) + 1;
    if (roll >= target || roll === 6) {
        lander.hasBall = true;
        G.ball.carrier = lander;
        return `Ball scattered to (${nc},${nr}) — ${lander.pos} catches it! (rolled ${roll}, needed ${target}+)`;
    }
    // Failed catch — scatter again from this square
    return `${lander.pos} fails to catch (rolled ${roll}, needed ${target}+). ` + scatterBall(G);
}

// ── tryPickup ─────────────────────────────────────────────────────
// Called when a player moves onto the ball's square.
// AG roll modified by opposing tackle zones on that square.

function tryPickup(G, p) {
    if (G.ball.carrier || G.ball.col !== p.col || G.ball.row !== p.row) return null;
    const tzs    = _countTackleZones(G, p.side, p.col, p.row);
    const target = Math.min(p.ag + tzs, 6);
    const roll   = Math.floor(Math.random() * 6) + 1;
    if (roll >= target || roll === 6) {
        p.hasBall      = true;
        G.ball.carrier = p;
        return `${p.pos} picks up the ball (rolled ${roll}, needed ${target}+).`;
    }
    const scatterMsg = scatterBall(G);
    endTurn(G);
    return `${p.pos} fails to pick up (rolled ${roll}, needed ${target}+). ${scatterMsg} TURNOVER`;
}

// ── checkTouchdown ────────────────────────────────────────────────
// Returns a score message if p just scored, null otherwise.

function checkTouchdown(G, p) {
    if (!p.hasBall) return null;
    const scored =
        (p.side === 'away' && p.row === ROWS - 1) ||
        (p.side === 'home' && p.row === 0);
    if (!scored) return null;
    G.score       = G.score || { home: 0, away: 0 };
    G.score[p.side] += 1;
    return `TOUCHDOWN! ${p.side.toUpperCase()} scores! (${G.score.home}–${G.score.away})`;
}

// ── knockDown ─────────────────────────────────────────────────────
// Sets a player prone, drops the ball, rolls armour + injury.
// opts.attacker — the blocking player (for Mighty Blow).
// Returns a description string of the armor/injury result.

function knockDown(G, p, { attacker } = {}) {
    p.status = 'prone';
    let scatterMsg = '';
    if (p.hasBall) {
        p.hasBall      = false;
        G.ball.carrier = null;
        G.ball.col     = p.col;
        G.ball.row     = p.row;
        scatterMsg     = ' ' + scatterBall(G);
    } else if (!G.ball.carrier && G.ball.col === p.col && G.ball.row === p.row) {
        // Player fell onto a loose ball — it scatters
        scatterMsg     = ' ' + scatterBall(G);
    }

    const { armorRoll, armorBroken, injuryRoll, outcome } = rollArmourAndInjury(p, attacker);

    if (!armorBroken) {
        return `AV ${armorRoll}/${p.av} — armour holds.${scatterMsg}`;
    }

    if (outcome === 'stunned') {
        p.status = 'stunned';
        return `AV ${armorRoll}/${p.av} broken! Inj ${injuryRoll}: Stunned.${scatterMsg}`;
    }
    if (outcome === 'ko') {
        p.status = 'ko';
        p.col    = -1;
        return `AV ${armorRoll}/${p.av} broken! Inj ${injuryRoll}: KO'd!${scatterMsg}`;
    }
    // casualty
    p.status = 'casualty';
    p.col    = -1;
    return `AV ${armorRoll}/${p.av} broken! Inj ${injuryRoll}: CASUALTY!${scatterMsg}`;
}

// ═══════════════════════════════════════════════════════════════
//  BLITZ RESOLUTION
// ═══════════════════════════════════════════════════════════════

// ── activateBlitz ─────────────────────────────────────────────────
// Step 1: player declares a blitz action. Activates the player and
// enters targeting mode — no target yet, no movement, no dice.
// Cancel is still available until the first step is taken.

function activateBlitz(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p || p.side !== G.active || p.usedAction || G.activated) return null;
    if (p.status === 'stunned') return null;   // stunned players can't act at all
    G.activated  = p;
    G.blitz      = 'targeting';
    G.hasBlitzed = true;  // committed on declaration; persists even if MA runs out before blocking
    // Prone blitzer stands up immediately; store flag so cancel can restore the state
    if (p.status === 'prone') {
        p.status  = 'active';
        p.maLeft  = Math.max(0, p.maLeft - 3);
        G.blitzFromProne = true;
    }
    return `${p.pos} declares blitz — click a target`;
}

// ── setBlitzTarget ────────────────────────────────────────────────
// Step 2: player picks the enemy to blitz. Records the target so
// movement highlights and adjacency checks work. Cancel still open.

function setBlitzTarget(G, defId) {
    const def = G.players.find(p => p.id === defId);
    if (!def || !G.activated || G.blitz !== 'targeting' || def.side === G.active) return null;
    G.blitz = { att: G.activated, def, phase: 'moving' };
    return `${G.activated.pos} targets ${def.pos} — move into range`;
}

// ── blitzBlock ───────────────────────────────────────────────────
// Step 3: attacker is adjacent — execute the block.
// Costs 1 MA (the block itself); hasBlitzed and G.blitz already set upstream.

function blitzBlock(G, att, target) {
    att.maLeft = Math.max(0, att.maLeft - 1);
    return declareBlock(G, att, target);
}
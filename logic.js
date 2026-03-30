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
    return dc <= 1 && dr <= 1
        && !(dc === 0 && dr === 0)
        && player.maLeft > 0
        && playerAt(G, col, row) === null;
}

function hasMovedYet(G) {
    if (!G.activated) return false;
    return G.activated.maLeft < G.activated.ma;
}

// ── Actions ───────────────────────────────────────────────────────
// These modify G. Each one does one thing and nothing else.

function activatePlayer(G, playerId) {
    const p = G.players.find(p => p.id === playerId);
    if (!p) return null;
    if (p.side !== G.active) return null;
    if (p.usedAction) return null;
    if (G.activated) return null;
    G.activated = p;
    G.sel       = p;
    return `${p.pos} activated`;
}

function cancelActivation(G) {
    if (!G.activated) return null;
    if (hasMovedYet(G)) return null;
    const name  = G.activated.pos;
    G.activated  = null;
    if (G.blitz !== null) {
        G.hasBlitzed = false;  // return blitz token — only consumed once you move
        G.blitz      = null;
    }
    return `${name} — action cancelled`;
}

function movePlayer(G, col, row) {
    if (!G.activated) return null;
    if (!canMoveTo(G, G.activated, col, row)) return null;
    G.activated.col    = col;
    G.activated.row    = row;
    G.activated.maLeft -= 1;
    G.sel = G.activated;
    // const msg = `${G.activated.pos} moves to (${col},${row}) · ${G.activated.maLeft} MA left`;
    if (G.activated.maLeft === 0) endActivation(G);
    // return msg;
    return null;
}

function endActivation(G) {
    if (!G.activated) return null;
    const name = G.activated.pos;
    G.activated.usedAction = true;
    G.activated = null;
    G.blitz     = null;
    return `${name} done`;
}

function endTurn(G) {
    if (G.activated) endActivation(G);
    for (const p of G.players) {
        if (p.side === G.active) {
            p.usedAction = false;
            p.maLeft     = p.ma;
        }
    }
    const prev   = G.active;
    G.active     = G.active === 'home' ? 'away' : 'home';
    G.sel        = null;
    G.hasBlitzed = false; // Reset blitz flag at turn end
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
            [4,15],[6,15],          // 2 behind line
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
        playerAt, canMoveTo, hasMovedYet, fixReferences,
        activatePlayer, cancelActivation,
        movePlayer, endActivation,
        endTurn,
        isAdjacent, isStanding, inTackleZoneOf,
        countAssists, blockDiceCount, getBlockTargets,
        BLOCK_FACES, rollBlockDice, getPushSquares,
        declareBlock, pickBlockFace, pickPushSquare, resolveFollowUp, knockDown,
        activateBlitz, setBlitzTarget, blitzBlock,
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
    const { attStr, defStr, attAssists, defAssists } = countAssists(G, att, def);
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

        case 'ATT_DOWN':
            knockDown(G, att);
            G.block = null;
            G.blitz = null;
            G.activated = null;
            att.usedAction = true;
            return `${att.pos} is knocked down! TURNOVER`;

        case 'BOTH_DOWN':
            knockDown(G, att);
            knockDown(G, def);
            G.block = null;
            G.blitz = null;
            G.activated = null;
            att.usedAction = true;
            return `Both players are knocked down! TURNOVER`;

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
    if (chosenFace.id === 'DEF_STUMBLES' || chosenFace.id === 'DEF_DOWN') {
        knockDown(G, def);
        msg += ` ${def.pos} is knocked down!`;
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

// ── knockDown ─────────────────────────────────────────────────────
// Sets a player to prone and rolls armour.

function knockDown(G, p) {
    p.status = 'prone';
    if (p.hasBall) {
        p.hasBall        = false;
        G.ball.carrier   = null;
        // Ball scatters — simple version: stays in same square for now
    }
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
    G.activated  = p;
    G.blitz      = 'targeting';
    G.hasBlitzed = true;  // committed on declaration; persists even if MA runs out before blocking
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
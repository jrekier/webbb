// dice.js
// Pure random rolls — no G, no side effects beyond returning results.

function d6() { return Math.floor(Math.random() * 6) + 1; }

// ── rush ─────────────────────────────────────────────────────────
// One Go-For-It roll: needs 2+ to succeed.
// Returns { roll, failed }.

function rush() {
    const roll   = d6();
    const failed = roll === 1;
    return { roll, failed };
}

// ── dodge ─────────────────────────────────────────────────────────
// Roll to leave a tackle zone. A roll of 6 always succeeds.
// Returns { roll, target, failed }.

function dodge(target) {
    const roll   = d6();
    const failed = roll !== 6 && roll < target;
    return { roll, target, failed };
}

// ── BLOCK_FACES / rollBlockDice ───────────────────────────────────
// The six faces of the block die, and the roller.

var BLOCK_FACES = [
    { id: 'ATT_DOWN',      label: 'Attacker\nDown',     cls: 'bad'  },
    { id: 'BOTH_DOWN',     label: 'Both\nDown',          cls: 'skull'},
    { id: 'PUSH',          label: 'Push',                cls: ''     },
    { id: 'PUSH',          label: 'Push',                cls: ''     },
    { id: 'DEF_STUMBLES',  label: 'Defender\nStumbles',  cls: 'good' },
    { id: 'DEF_DOWN',      label: 'Defender\nDown',      cls: 'good' },
];

function rollBlockDice(n) {
    const results = [];
    for (let i = 0; i < n; i++) {
        results.push({ ...BLOCK_FACES[Math.floor(Math.random() * BLOCK_FACES.length)] });
    }
    return results;
}

// ── rollArmourAndInjury ───────────────────────────────────────────
// Rolls 2d6 armour and (if broken) 2d6 injury.
// attacker may have Mighty Blow; p may have Thick Skull.
// Returns { armorRoll, armorBroken, injuryRoll, outcome }.
// outcome: 'stunned' | 'ko' | 'casualty' | null (armor held).

function rollArmourAndInjury(p, attacker) {
    const d1a = d6();
    const d2a = d6();
    const rawArmor   = d1a + d2a;
    const mightyBlow = attacker?.skills?.includes('Mighty Blow') ? 1 : 0;

    const wouldBreakWithBonus = rawArmor + mightyBlow >= p.av;
    const applyBonusToArmor  = mightyBlow > 0 && rawArmor < p.av && wouldBreakWithBonus;
    const armorRoll          = applyBonusToArmor ? rawArmor + mightyBlow : rawArmor;
    const injuryBonus        = mightyBlow > 0 && !applyBonusToArmor ? mightyBlow : 0;

    if (armorRoll < p.av) {
        return { armorRoll, armorBroken: false, injuryRoll: null, outcome: null };
    }

    const d1i        = d6();
    const d2i        = d6();
    const injuryRoll = d1i + d2i + injuryBonus;
    const thickSkull = p.skills?.includes('Thick Skull');
    const stunty     = p.skills?.includes('Stunty');

    let outcome;
    if (stunty) {
        if      (injuryRoll <= 6) outcome = 'stunned';
        else if (injuryRoll <= 8) outcome = thickSkull ? 'stunned' : 'ko';
        else                      outcome = 'casualty';
    } else {
        if      (injuryRoll <= 7) outcome = 'stunned';
        else if (injuryRoll <= 9) outcome = thickSkull ? 'stunned' : 'ko';
        else                      outcome = 'casualty';
    }

    return { armorRoll, armorBroken: true, injuryRoll, outcome };
}

// ── rollInjury ────────────────────────────────────────────────────
// Rolls 2d6 injury only (armour already confirmed broken by caller).
// Returns { injuryRoll, outcome }.

function rollInjury(p) {
    const d1 = d6();
    const d2 = d6();
    const injuryRoll  = d1 + d2;
    const thickSkull  = p.skills?.includes('Thick Skull');
    const stunty      = p.skills?.includes('Stunty');
    let outcome;
    if (stunty) {
        if      (injuryRoll <= 6) outcome = 'stunned';
        else if (injuryRoll <= 8) outcome = thickSkull ? 'stunned' : 'ko';
        else                      outcome = 'casualty';
    } else {
        if      (injuryRoll <= 7) outcome = 'stunned';
        else if (injuryRoll <= 9) outcome = thickSkull ? 'stunned' : 'ko';
        else                      outcome = 'casualty';
    }
    return { d1, d2, injuryRoll, outcome };
}

// ── rollCrowdInjury ───────────────────────────────────────────────
// Crowd always breaks armour — rolls only 2d6 injury.
// Returns { injuryRoll, outcome }.

function rollCrowdInjury(p) {
    const d1 = d6();
    const d2 = d6();
    const injuryRoll = d1 + d2;
    const thickSkull = p.skills?.includes('Thick Skull');
    const stunty     = p.skills?.includes('Stunty');
    let outcome;
    if (stunty) {
        if      (injuryRoll <= 6) outcome = thickSkull ? 'ko' : 'stunned';
        else if (injuryRoll <= 8) outcome = thickSkull ? 'stunned' : 'ko';
        else                      outcome = 'casualty';
    } else {
        if      (injuryRoll <= 7) outcome = thickSkull ? 'ko' : 'stunned';
        else if (injuryRoll <= 9) outcome = thickSkull ? 'stunned' : 'ko';
        else                      outcome = 'casualty';
    }
    return { injuryRoll, outcome };
}

if (typeof module !== 'undefined') {
    module.exports = { d6, rush, dodge, BLOCK_FACES, rollBlockDice, rollArmourAndInjury, rollInjury, rollCrowdInjury };
}

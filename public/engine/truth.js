// truth.js
// Single source of truth for what actions the selected player can take right now.
// Called by updateButtons() (input.js) and _openWheel() (render.js) so
// that a new action only needs to be added here.

if (typeof module !== 'undefined') {
    var { actionAllowed, isStanding, canStillCancel, getBlockTargets, teamRerollsLeft } = require('./helpers.js');
}

function getGameContext(G, sel, NET) {
    const myTurn     = !NET.online || NET.side === G.active;
    const noAction   = !G.activated && !G.block && !G.targeting;
    const selProne   = sel && sel.status === 'prone';
    const selStunned = sel && sel.status === 'stunned';

    const chargeOk = G.phase !== 'kickoff_charge' || G.chargeMovesLeft > 0;

    // Razzle-dazzle buys one extra declaration for a single player.
    const razzleAgain = !!sel?.usedAction && (sel?.razzleLeft > 0);
    const allow = key => !sel || actionAllowed(sel, key);

    const canDeclare = myTurn && sel
        && sel.side === G.active
        && (!sel.usedAction || razzleAgain)
        && sel.col >= 0
        && noAction
        && !selStunned
        && sel.status !== 'ko'
        && sel.status !== 'casualty'
        && (!selProne || sel.maLeft + sel.rushLeft >= 3)
        && chargeOk;

    const canBlitz = myTurn && sel && allow('Blitz')
        && sel.side === G.active
        && (!sel.usedAction || razzleAgain)
        && noAction
        && !selStunned
        && !G.hasBlitzed
        && G.players.some(p => p.side !== G.active && isStanding(p))
        && chargeOk;

    const hasTargets = canDeclare && sel && allow('Block')
        && getBlockTargets(G, sel).length > 0;

    const canSecure = canDeclare && allow('Secure') && !G.ball.carrier
        && !G.players.some(p =>
            p.side !== G.active && isStanding(p)
            && Math.abs(p.col - G.ball.col) <= 2 && Math.abs(p.row - G.ball.row) <= 2
        );

    const foulReady = myTurn && sel && sel.side === G.active && allow('Foul')
        && (!sel.usedAction || razzleAgain) && noAction
        && sel.status === 'active'
        && G.players.some(p => p.side !== G.active
            && (p.status === 'prone' || p.status === 'stunned') && p.col >= 0);

    const canFoul = foulReady && !G.hasFouled;

    // Grudge Match buys a SECOND foul in a turn that has already used one, and
    // the fouler cannot be Sent-off for it. Declared like any other action, so
    // it is offered only when a normal foul is not available.
    // Razzle-dazzle is announced as the player activates, before any Action.
    const canRazzle = myTurn && sel && sel.side === G.active
        && !sel.usedAction && !(sel.razzleLeft > 0) && noAction
        && sel.col >= 0 && sel.status === 'active'
        && (G.desperateMeasures?.[G.active] || []).includes('razzleDazzle')
        && !G.desperateUsed?.[G.active]?.razzleDazzle;

    const canGrudgeFoul = foulReady && G.hasFouled
        && (G.desperateMeasures?.[G.active] || []).includes('grudgeMatch')
        && !G.desperateUsed?.[G.active]?.grudgeMatch;

    const canHandoff = myTurn && sel && sel.side === G.active && allow('Handoff')
        && (!sel.usedAction || razzleAgain) && noAction && !G.hasHandedOff
        && sel.status !== 'stunned';

    const canPass = myTurn && sel && sel.side === G.active && allow('Pass')
        && (!sel.usedAction || razzleAgain) && noAction && !G.hasPassed
        && sel.status !== 'stunned';

    const canThrow = myTurn && G.passing === true && G.activated && G.activated.hasBall;

    const canCancel = myTurn && (G.passing === 'targeting'
        || G.block === 'targeting'
        || G.throwTeamMate?.phase === 'targeting'
        || (G.activated && canStillCancel(G) && !G.block));

    const canStop = myTurn && G.activated && (!canStillCancel(G) || G.stoodUpFromProne) && !G.block
        && G.passing !== 'targeting' && G.throwTeamMate?.phase !== 'targeting';

    const hasPV = !!(sel?.specialSkills?.includes('Projectile Vomit') || sel?.skills?.includes('Projectile Vomit'));
    const canDeclarePV = hasPV && allow('Vomit')
        && ((canDeclare && !selProne)
            || (myTurn && G.activated?.id === sel?.id && G.blitz?.phase === 'moving'));

    const hasStab = sel?.skills?.includes('Stab');
    const canDeclareStab = hasStab && allow('Stab')
        && getBlockTargets(G, sel).length > 0
        && ((canDeclare && !selProne)
            || (myTurn && G.activated?.id === sel?.id && G.blitz?.phase === 'moving'));

    const canDeclareTTM = canDeclare && allow('TTM') && !G.hasThrownMate
        && !!sel?.skills?.includes('Throw Team-Mate');

    const canPickASTarget = myTurn && !!G.animalSavagery
        && G.animalSavagery.phase === 'pick-target'
        && (!NET.online || NET.side === G.active);

    const canUseFend           = G.block?.phase === 'fend-choice'
        && (!NET.online || NET.side !== G.active);

    const canUseStandFirm      = G.block && G.block.phase === 'stand-firm-choice'
        && (!NET.online || NET.side !== G.active);

    const canUseStripBall      = G.block?.phase === 'strip-ball-choice'
        && (!NET.online || NET.side === G.active);

    const canUseWrestle        = G.block?.phase === 'wrestle-choice'
        && (!NET.online || NET.side === G.block?.wrestleSide);

    const canUseJuggernaut     = G.block?.phase === 'juggernaut-choice'
        && (!NET.online || NET.side === G.active);

    // Block-dice rerolls — the active coach (attacker) decides, before a face is
    // picked and before any reroll has been used on these dice.
    const blockReroll = G.block?.phase === 'pick-face' && !G.block.rerolled
        && (!NET.online || NET.side === G.active);
    const canRerollBlock = blockReroll && teamRerollsLeft(G, G.block.att.side) > 0;
    const canProBlock    = blockReroll
        && !!G.block.att?.skills?.includes('Pro') && !G.block.att?.usedPro;
    const blockProPickDie = G.block?.phase === 'pro-pick-die'
        && (!NET.online || NET.side === G.active);

    const canUseDivingTackle   = G.pending?.kind === 'divingTackle'
        && (!NET.online || NET.side === G.pending.side);

    const canChooseNoIntercept = G.pending?.kind === 'intercept' && (!NET.online || NET.side !== G.active);

    const canUseTeamReroll     = G.pending?.kind === 'reroll' && (!NET.online || NET.side === G.active);

    const canUseBribe          = G.pending?.kind === 'bribe'
        && (!NET.online || NET.side === G.pending.side);

    const canConfirmSetup = (G.phase === 'setup') && (!NET.online || NET.side === G.setupSide);

    // Kickoff event phase flags
    const isKickoffSolidDefence = G.phase === 'kickoff_soliddefence';
    const isKickoffQuickSnap    = G.phase === 'kickoff_quicksnap';
    const isKickoffCharge       = G.phase === 'kickoff_charge';
    const isKickoffHighKick     = G.phase === 'kickoff_highkick';

    const canConfirmSolidDefence = isKickoffSolidDefence && (!NET.online || NET.side === G.kicker);
    const canConfirmQuickSnap    = isKickoffQuickSnap    && (!NET.online || NET.side === G.receiver);
    const canConfirmCharge       = isKickoffCharge       && (!NET.online || NET.side === G.kicker);
    const canSkipHighKick        = isKickoffHighKick     && (!NET.online || NET.side === G.receiver);

    const inSetup   = G.phase === 'setup';
    const inSpecial = G.phase === 'kick'
        || G.phase === 'touchback'
        || G.phase === 'kickoff_touchback'
        || G.phase === 'gameover'
        || isKickoffSolidDefence
        || isKickoffQuickSnap
        || isKickoffHighKick;

    return {
        myTurn,
        noAction,
        selProne,
        selStunned,
        inSetup,
        inSpecial,
        canDeclare,
        canBlitz,
        hasTargets,
        canSecure,
        canFoul,
        canGrudgeFoul,
        canRazzle,
        canHandoff,
        canPass,
        canThrow,
        canCancel,
        canStop,
        canDeclarePV,
        canDeclareStab,
        canDeclareTTM,
        canPickASTarget,
        canUseFend,
        canUseStandFirm,
        canUseStripBall,
        canUseWrestle,
        canUseJuggernaut,
        canRerollBlock,
        canProBlock,
        blockProPickDie,
        canUseDivingTackle,
        canChooseNoIntercept,
        canConfirmSetup,
        canUseTeamReroll,
        canUseBribe,
        isKickoffSolidDefence, isKickoffQuickSnap, isKickoffCharge, isKickoffHighKick,
        canConfirmSolidDefence, canConfirmQuickSnap, canConfirmCharge, canSkipHighKick,
    };
}

if (typeof module !== 'undefined') {
    module.exports = { getGameContext };
}

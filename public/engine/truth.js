// truth.js
// Single source of truth for what actions the selected player can take right now.
// Called by updateButtons() (input.js) and _openWheel() (mobile.js) so
// that a new action only needs to be added here.

if (typeof module !== 'undefined') {
    var { isStanding, canStillCancel, getBlockTargets } = require('./helpers.js');
}

function getGameContext(G, sel, NET) {
    const myTurn     = !NET.online || NET.side === G.active;
    const noAction   = !G.activated && !G.block && !G.targeting;
    const selProne   = sel && sel.status === 'prone';
    const selStunned = sel && sel.status === 'stunned';

    const chargeOk = G.phase !== 'kickoff_charge' || G.chargeMovesLeft > 0;

    const canDeclare = myTurn && sel
        && sel.side === G.active
        && !sel.usedAction
        && sel.col >= 0
        && noAction
        && !selStunned
        && sel.status !== 'ko'
        && sel.status !== 'casualty'
        && (!selProne || sel.maLeft + sel.rushLeft >= 3)
        && chargeOk;

    const canBlitz = myTurn && sel
        && sel.side === G.active
        && !sel.usedAction
        && noAction
        && !selStunned
        && !G.hasBlitzed
        && G.players.some(p => p.side !== G.active && isStanding(p))
        && chargeOk;

    const hasTargets = canDeclare && sel
        && getBlockTargets(G, sel).length > 0;

    const canSecure = canDeclare && !G.ball.carrier
        && !G.players.some(p =>
            p.side !== G.active && isStanding(p)
            && Math.abs(p.col - G.ball.col) <= 2 && Math.abs(p.row - G.ball.row) <= 2
        );

    const canFoul = myTurn && sel && sel.side === G.active
        && !sel.usedAction && noAction && !G.hasFouled
        && sel.status === 'active'
        && G.players.some(p => p.side !== G.active
            && (p.status === 'prone' || p.status === 'stunned') && p.col >= 0);

    const canHandoff = myTurn && sel && sel.side === G.active
        && !sel.usedAction && noAction && !G.hasHandedOff
        && sel.status !== 'stunned';

    const canPass = myTurn && sel && sel.side === G.active
        && !sel.usedAction && noAction && !G.hasPassed
        && sel.status !== 'stunned';

    const canThrow = myTurn && G.passing === true && G.activated && G.activated.hasBall;

    const canCancel = myTurn && (G.passing === 'targeting'
        || G.block === 'targeting'
        || G.throwTeamMate?.phase === 'targeting'
        || (G.activated && canStillCancel(G) && !G.block));

    const canStop = myTurn && G.activated && (!canStillCancel(G) || G.stoodUpFromProne) && !G.block
        && G.passing !== 'targeting' && G.throwTeamMate?.phase !== 'targeting';

    const hasPV = !!(sel?.specialSkills?.includes('Projectile Vomit') || sel?.skills?.includes('Projectile Vomit'));
    const canDeclarePV = hasPV
        && ((canDeclare && !selProne)
            || (myTurn && G.activated?.id === sel?.id && G.blitz?.phase === 'moving'));

    const hasStab = sel?.skills?.includes('Stab');
    const canDeclareStab = hasStab
        && getBlockTargets(G, sel).length > 0
        && ((canDeclare && !selProne)
            || (myTurn && G.activated?.id === sel?.id && G.blitz?.phase === 'moving'));

    const canDeclareTTM = canDeclare && !G.hasThrownMate
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

    const canChooseNoIntercept = !!G.interceptionChoice && (!NET.online || NET.side !== G.active);

    const canUseTeamReroll     = !!G.pendingReroll && (!NET.online || NET.side === G.active);

    const canUseBribe          = !!G.bribePending
        && (!NET.online || NET.side === G.bribePending?.side);

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

// truth.js
// Single source of truth for what actions the selected player can take right now.
// Called by updateButtons() (input.js) and _openWheel() (mobile.js) so
// that a new action only needs to be added here.

if (typeof module !== 'undefined') {
    var { isStanding, canStillCancel, getBlockTargets } = require('./helpers.js');
}

function getGameContext(G, sel, NET) {
    const myTurn     = !NET.online || NET.side === G.active;
    const noAction   = !G.activated && !G.block;
    const selProne   = sel && sel.status === 'prone';
    const selStunned = sel && sel.status === 'stunned';

    const canDeclare = myTurn && sel
        && sel.side === G.active
        && !sel.usedAction
        && sel.col >= 0
        && noAction
        && !selStunned
        && sel.status !== 'ko'
        && sel.status !== 'casualty'
        && (!selProne || sel.maLeft + sel.rushLeft >= 3);

    const canBlitz = myTurn && sel
        && sel.side === G.active
        && !sel.usedAction
        && noAction
        && !selStunned
        && !G.hasBlitzed
        && G.players.some(p => p.side !== G.active && isStanding(p));

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
        || G.ttm?.phase === 'targeting'
        || (G.activated && canStillCancel(G) && !G.block));

    const canStop = myTurn && G.activated && (!canStillCancel(G) || G.stoodUpFromProne) && !G.block
        && G.passing !== 'targeting' && G.ttm?.phase !== 'targeting';

    const canDeclarePV = !!sel?.specialSkills?.includes('Projectile Vomit')
        && ((canDeclare && !selProne)
            || (myTurn && G.activated?.id === sel?.id && G.blitz?.phase === 'moving'));

    const canDeclareTTM = canDeclare && !G.hasThrownMate
        && !!sel?.skills?.includes('Throw Team-Mate');

    const canUseStandFirm      = G.block && G.block.phase === 'stand-firm-choice'
        && (!NET.online || NET.side !== G.active);

    const canChooseNoIntercept = !!G.interceptionChoice && (!NET.online || NET.side !== G.active);

    const canConfirmSetup = (G.phase === 'setup') && (!NET.online || NET.side === G.setupSide);

    const inSetup   = G.phase === 'setup';
    const inSpecial = G.phase === 'kick' || G.phase === 'touchback' || G.phase === 'gameover';

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
        canDeclareTTM,
        canUseStandFirm,
        canChooseNoIntercept,
        canConfirmSetup,
    };
}

if (typeof module !== 'undefined') {
    module.exports = { getGameContext };
}

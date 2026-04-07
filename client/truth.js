// truth.js
// Single source of truth for what actions the selected player can take right now.
// Called by updateButtons() (input.js), syncMobileHud() (mobile.js), and
// _openWheel() (mobile.js) so that a new action only needs to be added here.

function getGameContext(G, sel, NET) {
    const myTurn     = !NET.online || NET.side === G.active;
    const noAction   = !G.activated && !G.block;
    const selProne   = sel && sel.status === 'prone';
    const selStunned = sel && sel.status === 'stunned';

    const canDeclare = myTurn && sel
        && sel.side === G.active
        && !sel.usedAction
        && noAction
        && !selStunned
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
        || (G.activated && canStillCancel(G) && !G.block));

    const canStop = myTurn && G.activated && !canStillCancel(G) && !G.block && G.passing !== 'targeting';

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
        canChooseNoIntercept,
        canConfirmSetup,
    };
}

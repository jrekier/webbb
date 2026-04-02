// input.js
// Translates clicks and button presses into logic calls.
// Online: sends actions to server. Offline: applies locally.

// Drag state for setup phase — also read by render.js for the ghost
var setupDrag     = null;  // { player, pixelX, pixelY }
var _dragMoved    = false;

function setupInput() {
    canvas.addEventListener('click',     handleClick);
    canvas.addEventListener('mousedown', _onMouseDown);
    canvas.addEventListener('mousemove', _onMouseMove);
    canvas.addEventListener('mouseup',   _onMouseUp);
    setupTouch();
}

function _onMouseDown(e) {
    if (G.phase !== 'setup') return;
    const rect = canvas.getBoundingClientRect();
    const px   = e.clientX - rect.left;
    const py   = e.clientY - rect.top + cameraY;
    const col  = Math.floor(px / CELL);
    const row  = Math.floor(py / CELL);
    const p    = playerAt(G, col, row);
    if (p && p.side === G.setupSide && (!NET.online || NET.side === G.setupSide)) {
        setupDrag  = { player: p, pixelX: e.clientX - rect.left, pixelY: e.clientY - rect.top };
        _dragMoved = false;
        e.preventDefault();
    }
}

function _onMouseMove(e) {
    if (!setupDrag) return;
    const rect     = canvas.getBoundingClientRect();
    setupDrag.pixelX = e.clientX - rect.left;
    setupDrag.pixelY = e.clientY - rect.top;
    _dragMoved = true;
    render();
}

function _onMouseUp(e) {
    if (!setupDrag) return;
    const drag = setupDrag;
    setupDrag  = null;
    if (_dragMoved) {
        const rect = canvas.getBoundingClientRect();
        const col  = Math.floor((e.clientX - rect.left) / CELL);
        const row  = Math.floor((e.clientY - rect.top + cameraY) / CELL);
        if (NET.online) {
            sendAction({ type: 'SETUP_MOVE', playerId: drag.player.id, col, row });
        } else {
            moveSetupPlayer(G, drag.player.id, col, row);
        }
    }
    render();
}

// ── handleClick ──────────────────────────────────────────────────
function handleClick(event) {
    if (G.phase !== 'play') return; // toss and setup handled elsewhere
    const rect = canvas.getBoundingClientRect();
    const px   = event.clientX - rect.left;
    const py   = event.clientY - rect.top;

    // Follow-up overlay click
    if (G.block && G.block.phase === 'follow-up') {
        const isAttacker = !NET.online || NET.side === G.active;
        if (isAttacker && G.block._yesRect && G.block._noRect) {
            const inRect = (r) => px >= r.x && px <= r.x+r.w && py >= r.y && py <= r.y+r.h;
            if (inRect(G.block._yesRect)) {
                if (NET.online) sendAction({ type:'FOLLOW_UP', choice:true });
                else { const msg = resolveFollowUp(G, true);  if (msg) log(msg); }
                render(); return;
            }
            if (inRect(G.block._noRect)) {
                if (NET.online) sendAction({ type:'FOLLOW_UP', choice:false });
                else { const msg = resolveFollowUp(G, false); if (msg) log(msg); }
                render(); return;
            }
        }
        return; // block all other clicks during follow-up
    }

    // Dice overlay click — pick a block face
    if (G.block && G.block.phase === 'pick-face') {
        const chooser = G.block.chooser;

        // Work out which side gets to pick:
        // chooser 'att' = active team, chooser 'def' = non-active team
        const chooserSide = chooser === 'att' ? G.active
                          : (G.active === 'home' ? 'away' : 'home');

        // Offline: always my pick. Online: only if I'm the chooser's side.
        const isMyPick = !NET.online || NET.side === chooserSide;

        if (isMyPick) {
            const idx = G.block.rolls.findIndex(f =>
                f._rect &&
                px >= f._rect.x && px <= f._rect.x + f._rect.w &&
                py >= f._rect.y && py <= f._rect.y + f._rect.h
            );
            if (idx >= 0) {
                if (NET.online) {
                    sendAction({ type: 'BLOCK_FACE', faceIdx: idx });
                } else {
                    const msg = pickBlockFace(G, G.block.rolls[idx]);
                    if (msg) log(msg);
                }
                render();
                return;
            }
        }
        return; // block all other clicks while overlay is open
    }

    const col    = Math.floor(px / CELL);
    const row    = Math.floor((py + cameraY) / CELL);
    const player = playerAt(G, col, row);

    if (player) clickPlayer(player);
    else        clickCell(col, row);

    render();
}

// ── clickPlayer ──────────────────────────────────────────────────
function clickPlayer(player) {
    if (G.block && G.block.phase === 'pick-push') return;

    G.sel = player;

    // Block targeting — must be adjacent already
    if (G.block === 'targeting') {
        if (player.side !== G.active && isAdjacent(G.activated, player)) {
            if (NET.online) {
                sendAction({ type: 'BLOCK_START', attId: G.activated.id, defId: player.id });
                G.block = null;
            } else {
                const msg = declareBlock(G, G.activated, player);
                if (msg) log(msg);
            }
        }
        return;
    }

    // Blitz targeting — declare the target, then player moves freely
    if (G.blitz === 'targeting') {
        if (player.side !== G.active) {
            if (NET.online) {
                sendAction({ type: 'BLITZ_TARGET', defId: player.id });
            } else {
                const msg = setBlitzTarget(G, player.id);
                if (msg) log(msg);
            }
        }
        return;
    }

    // Blitz moving — click the declared target when adjacent to execute the block
    if (G.blitz && G.blitz.phase === 'moving' && player.id === G.blitz.def.id) {
        if (isAdjacent(G.activated, player)) {
            if (NET.online) {
                sendAction({ type: 'BLITZ_START', attId: G.activated.id, defId: player.id });
            } else {
                const msg = blitzBlock(G, G.activated, player);
                if (msg) log(msg);
            }
        }
        return;
    }
}

// ── clickCell ────────────────────────────────────────────────────
function clickCell(col, row) {
    // Push square pick — attacker only
    if (G.block && G.block.phase === 'pick-push') {
        const isAttacker = !NET.online || NET.side === G.active;
        if (!isAttacker) return;
        const valid = G.block.pushSquares.some(([c, r]) => c === col && r === row);
        if (valid) {
            if (NET.online) {
                sendAction({ type: 'BLOCK_PUSH', col, row });
            } else {
                const msg = pickPushSquare(G, col, row);
                if (msg) log(msg);
            }
        }
        return;
    }

    // Movement
    if (!G.activated) return;
    if (G.blitz === 'targeting') return;
    const { allowed } = canMoveTo(G, G.activated, col, row);
    if (!allowed) return;
    if (NET.online) {
        sendAction({ type: 'MOVE', col, row });
    } else {
        const msg = movePlayer(G, col, row);
        if (msg) log(msg);
    }
}

// ── Button handlers ──────────────────────────────────────────────
function onClickStandUp() {
    if (!G.sel || G.sel.side !== G.active || G.sel.status !== 'prone') return;
    if (G.sel.usedAction || G.activated) return;
    if (NET.online) {
        sendAction({ type: 'STAND_UP', playerId: G.sel.id });
    } else {
        const msg = standUp(G, G.sel.id);
        if (msg) log(msg);
        render();
    }
}

function onClickSecureBall() {
    if (!G.sel || G.sel.side !== G.active) return;
    if (NET.online) {
        sendAction({ type: 'SECURE_BALL', playerId: G.sel.id });
    } else {
        const msg = secureBall(G, G.sel.id);
        if (msg) log(msg);
        render();
    }
}

function onClickMove() {
    if (!G.sel || G.sel.side !== G.active) return;
    if (G.sel.usedAction || G.activated) return;
    if (NET.online) {
        sendAction({ type: 'ACTIVATE', playerId: G.sel.id });
    } else {
        const msg = activatePlayer(G, G.sel.id);
        if (msg) log(msg);
        render();
    }
}

function onClickBlock() {
    if (!G.sel || G.sel.side !== G.active) return;
    if (G.sel.usedAction || G.activated) return;
    if (G.sel.status !== 'active') return;   // prone/stunned players can't block
    G.activated = G.sel;
    G.block     = 'targeting';
    log(`${G.sel.pos} declares block — click a target`);
    render();
}

function onClickBlitz() {
    if (!G.sel || G.sel.side !== G.active) return;
    if (G.sel.usedAction || G.activated) return;
    if (NET.online) {
        sendAction({ type: 'BLITZ_DECLARE', playerId: G.sel.id });
    } else {
        const msg = activateBlitz(G, G.sel.id);
        if (msg) log(msg);
        render();
    }
}

function onClickCancel() {
    if (G.block === 'targeting') {
        G.block     = null;
        G.activated = null;
        log('Action cancelled');
    } else if (NET.online) {
        sendAction({ type: 'CANCEL' });
    } else {
        const msg = cancelActivation(G);
        if (msg) log(msg);
    }
    render();
}

function onClickStop() {
    if (NET.online) {
        sendAction({ type: 'STOP' });
    } else {
        const msg = endActivation(G);
        if (msg) log(msg);
        render();
    }
}

function onClickConfirmSetup() {
    if (NET.online) {
        sendAction({ type: 'CONFIRM_SETUP' });
        return;
    }
    const result = confirmSetup(G, G.setupSide);
    if (!result) return;
    if (result.errors) {
        result.errors.forEach(e => log(e, 'error'));
    } else {
        log(result.msg, 'turn-marker');
    }
    render();
}

function onClickEndTurn() {
    if (NET.online) {
        sendAction({ type: 'END_TURN' });
    } else {
        const msg = endTurn(G);
        if (msg) log(msg, 'turn-marker');
        render();
    }
}

// ── updateButtons ────────────────────────────────────────────────
function updateButtons() {
    if (G.phase === 'setup') {
        ['btn-move','btn-block','btn-blitz','btn-stand-up',
         'btn-secure-ball','btn-cancel','btn-stop','btn-end-turn']
            .forEach(id => show(id, false));
        const mySetup = !NET.online || NET.side === G.setupSide;
        show('btn-confirm-setup', mySetup);
        document.getElementById('btn-confirm-setup').textContent =
            `Confirm ${(G.setupSide || '').toUpperCase()} Setup`;
        syncMobileHud();
        return;
    }
    show('btn-confirm-setup', false);

    const myTurn     = !NET.online || NET.side === G.active;
    const noAction   = !G.activated && !G.block;
    const selProne   = G.sel && G.sel.status === 'prone';
    const canDeclare = myTurn && G.sel
        && G.sel.side    === G.active
        && !G.sel.usedAction
        && noAction
        && !selProne;
    const canBlitz = myTurn && G.sel
        && G.sel.side    === G.active
        && !G.sel.usedAction
        && noAction
        && !G.hasBlitzed 
        && G.players.some(p => p.side !== G.active && isStanding(p));     
    const canStand   = myTurn && G.sel
        && G.sel.side    === G.active
        && !G.sel.usedAction
        && noAction
        && selProne;
    const hasTargets  = canDeclare && G.sel
        && getBlockTargets(G, G.sel).length > 0;
    const canSecure   = canDeclare && !G.ball.carrier;

    show('btn-move',        canDeclare);
    show('btn-block',       hasTargets);
    show('btn-blitz',       canBlitz);
    show('btn-stand-up',    canStand);
    show('btn-secure-ball', canSecure);
    show('btn-cancel',   myTurn && (G.block === 'targeting'
                            || (G.activated && canStillCancel(G) && !G.block)));
    show('btn-stop',     myTurn && G.activated && !canStillCancel(G) && !G.block);
    show('btn-end-turn', myTurn && !G.block);

    const btnEnd = document.getElementById('btn-end-turn');
    if (btnEnd.style.display !== 'none')
        btnEnd.textContent = `End ${G.active.toUpperCase()} Turn`;

    syncMobileHud();
}

function show(id, visible) {
    document.getElementById(id).style.display = visible ? '' : 'none';
}

// // ── canMoveTo — also used by render.js for highlights ─────────────
// function canMoveTo(G, player, col, row) {
//     const dc = Math.abs(player.col - col);
//     const dr = Math.abs(player.row - row);
//     const allowed = (dc <= 1 && dr <= 1 && !(dc === 0 && dr === 0) && player.maLeft + player.rushLeft > 0 && playerAt(G, col, row) === null);
//     const needsrush = (player.maLeft === 0);

//     // Dodge required if leaving a tackle zone
//     const needsDodge = G.players.some(enemy =>
//         enemy.side !== player.side && isStanding(enemy) && isAdjacent(player, enemy)
//     );
    
//     let dodgerolltarget = 0;
//     if (needsDodge) {
//         // Target: player's AG + 1, +1 per tackle zone covering the destination.
//         const destTZs = G.players.filter(enemy =>
//             enemy.side !== player.side
//             && isStanding(enemy)
//             && Math.abs(enemy.col - col) <= 1
//             && Math.abs(enemy.row - row) <= 1
//             && !(enemy.col === col && enemy.row === row)
//         ).length;
//         dodgerolltarget = Math.min(player.ag + destTZs, 6);
//     }

//     return { allowed, needsrush, dodgerolltarget }
// }

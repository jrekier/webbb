// input.js
// Translates pointer input and button presses into game logic calls.
//
// All canvas interaction uses the Pointer Events API, which unifies mouse,
// touch and pen into a single event stream and is correctly simulated by
// Firefox DevTools touch mode. The canvas has `touch-action: none` in CSS,
// so the browser surrenders all native touch gestures (scroll, zoom) and we
// control every frame ourselves.
//
// Online: sends actions to server. Offline: applies locally.

// ── Shared drag state ─────────────────────────────────────────────
// Also read by render.js (ghost drawing) and mobile.js (panel drag).

var setupDrag  = null;  // { player, pixelX, pixelY [, fromPanel] }
var _dragMoved = false;

// ── Canvas overlay state ──────────────────────────────────────────
// Read by render.js to draw aim indicators and move highlights.

var kickHover   = null;  // { col, row } — kick-phase aim square
var passHover   = null;  // { col, row } — pass-targeting overlay
var ttmHover    = null;  // { col, row } — TTM targeting overlay
var setupErrors = null;  // string[] | null — setup validation failures
var dragHover   = null;  // { col, row } | null — HTML5 drag-over highlight

// ── Canvas gesture state ──────────────────────────────────────────
// We track one pointer at a time; secondary fingers are ignored.
//
// _gesture shape while active:
// {
//   pointerId  — which pointer owns this gesture
//   type       — 'mouse' | 'touch' | 'pen'
//   startX     — clientX at pointerdown
//   startY     — clientY at pointerdown
//   phase      — 'pressing' | 'dragging' | 'panning' | 'cancelled'
//   camStart   — cameraY snapshot (set when phase becomes 'panning')
//   dragCandidate — player to drag if the pointer moves (setup only)
// }

var _gesture        = null;
var _longPressTimer = null;  // fires _onLongPress after 450 ms of stillness (touch/pen)

// ── Tap state (double-tap → tooltip) ─────────────────────────────
// Moved here from mobile.js now that _onTap lives in input.js.

var _lastTapTime = 0;
var _lastTapCol  = -1;
var _lastTapRow  = -1;
var _pendingTap  = null;  // { timer } — delayed single-tap in targeting states


// ── setupInput ────────────────────────────────────────────────────
// Wires up all canvas listeners. Called once from game.js after the
// canvas element exists.

function setupInput() {
    // Pointer Events handle mouse, touch and pen uniformly.
    // setPointerCapture (called inside _onPointerDown) routes all subsequent
    // pointermove / pointerup events back to the canvas even when the pointer
    // wanders outside, so we need no window-level listeners.
    canvas.addEventListener('pointerdown',   _onPointerDown);
    canvas.addEventListener('pointermove',   _onPointerMove);
    canvas.addEventListener('pointerup',     _onPointerUp);
    canvas.addEventListener('pointercancel', _onPointerCancel);
    canvas.addEventListener('pointerleave',  _onPointerLeave);

    // Right-click opens the action wheel on desktop.
    // Touch devices use long-press (handled via the long-press timer).
    canvas.addEventListener('contextmenu', _onContextMenu);

    // HTML5 Drag-and-Drop for the desktop sidebar → pitch path.
    // This is a separate event channel that coexists with Pointer Events.
    canvas.addEventListener('dragover',  _onCanvasDragOver);
    canvas.addEventListener('dragleave', _onCanvasDragLeave);
    canvas.addEventListener('drop',      _onCanvasDrop);
}


// ── _onPointerDown ────────────────────────────────────────────────
// Entry point for every new contact: left-click, touch-start, pen-tip.

function _onPointerDown(e) {
    // Ignore secondary pointers — we only track one gesture at a time.
    if (_gesture) return;

    // Capture so that pointermove / pointerup keep arriving here even when
    // the pointer leaves the canvas boundary (covers off-canvas drag drops).
    canvas.setPointerCapture(e.pointerId);

    const rect = canvas.getBoundingClientRect();
    const px   = e.clientX - rect.left;
    const py   = e.clientY - rect.top;

    _gesture = {
        pointerId:     e.pointerId,
        type:          e.pointerType,
        startX:        e.clientX,
        startY:        e.clientY,
        phase:         'pressing',
        dragCandidate: null,
    };

    // During setup, note which player (if any) sits under the contact so we
    // can promote to a drag if the pointer moves enough.
    if (G.phase === 'setup') {
        const col = Math.floor(px / CELL);
        const row = Math.floor((py + cameraY) / CELL);
        const p   = playerAt(G, col, row);
        if (p) { G.sel = p; render(); }
        if (p && p.side === G.setupSide && (!NET.online || NET.side === G.setupSide)) {
            _gesture.dragCandidate = p;
        }
    }

    if (e.pointerType === 'mouse') {
        // Mouse: begin drag immediately on mousedown — feels natural because
        // cursor feedback is instant. Touch waits for a movement threshold.
        if (_gesture.dragCandidate) {
            setupDrag      = { player: _gesture.dragCandidate, pixelX: px, pixelY: py };
            _dragMoved     = false;
            _gesture.phase = 'dragging';
        }
    } else {
        // Touch / pen: arm the long-press timer. An actual drag only starts
        // when the finger moves far enough (see _onPointerMove).
        _longPressTimer = setTimeout(() => {
            _longPressTimer = null;
            if (_gesture && _gesture.phase === 'pressing')
                _onLongPress(_gesture.startX, _gesture.startY);
        }, 450);
    }
}


// ── _onPointerMove ────────────────────────────────────────────────

function _onPointerMove(e) {
    const rect = canvas.getBoundingClientRect();
    const px   = e.clientX - rect.left;
    const py   = e.clientY - rect.top;

    // ── Active gesture updates ───────────────────────────────────
    if (_gesture && _gesture.pointerId === e.pointerId) {

        if (_gesture.phase === 'dragging' && setupDrag) {
            // Update the ghost position for both canvas drag and panel drag.
            setupDrag.pixelX = px;
            setupDrag.pixelY = py;
            _dragMoved       = true;
            render();
            return;
        }

        if (_gesture.phase === 'panning') {
            // Vertical pan: drag the pitch up/down.
            cameraY = _gesture.camStart - (e.clientY - _gesture.startY);
            clampCamera();
            render();
            return;
        }

        if (_gesture.phase === 'pressing') {
            const dx   = e.clientX - _gesture.startX;
            const dy   = e.clientY - _gesture.startY;
            const dist = dx * dx + dy * dy;

            if (dist > 64) {  // finger moved more than 8 px — commit to a gesture
                _clearLongPress();

                if (_gesture.dragCandidate) {
                    // Promote to a player drag (touch and mouse both land here
                    // for touch; mouse already becomes 'dragging' in pointerdown).
                    _gesture.phase = 'dragging';
                    setupDrag      = { player: _gesture.dragCandidate, pixelX: px, pixelY: py };
                    _dragMoved     = false;
                } else if (e.pointerType !== 'mouse') {
                    // Touch / pen without a drag target: pan the camera.
                    _gesture.phase    = 'panning';
                    _gesture.camStart = cameraY;
                } else {
                    // Mouse moved with no drag target — treat as cancelled so
                    // hover effects can resume on the next pointermove.
                    _gesture.phase = 'cancelled';
                }
            }
            return;
        }

        // 'cancelled' falls through to the hover section below.
    }

    // ── Mouse-only hover effects ─────────────────────────────────
    // Only update aim indicators and the inspect-card timer when the mouse
    // is actually inside the canvas and no active gesture is consuming it.
    if (e.pointerType !== 'mouse') return;
    if (_gesture && _gesture.phase !== 'cancelled') return;

    const overCanvas = px >= 0 && px <= rect.width && py >= 0 && py <= rect.height;
    if (!overCanvas) return;

    if (G.phase === 'kick') {
        kickHover = { col: Math.floor(px / CELL), row: Math.floor((py + cameraY) / CELL) };
        render();
    }
    if (G.passing === 'targeting' && !G.confirm) {
        passHover = { col: Math.floor(px / CELL), row: Math.floor((py + cameraY) / CELL) };
        render();
    }
    if (G.throwTeamMate?.phase === 'targeting' && !G.confirm) {
        ttmHover = { col: Math.floor(px / CELL), row: Math.floor((py + cameraY) / CELL) };
        render();
    }

}


// ── _onPointerUp ─────────────────────────────────────────────────

function _onPointerUp(e) {
    if (!_gesture || _gesture.pointerId !== e.pointerId) return;
    _clearLongPress();

    const phase = _gesture.phase;
    _gesture    = null;

    // ── Player drag drop ─────────────────────────────────────────
    if (phase === 'dragging' && setupDrag) {
        const drag = setupDrag;
        setupDrag  = null;

        if (!_dragMoved) {
            // Pointer went down and up on the same spot without moving.
            // Treat as a tap so double-tap tooltip still works in setup.
            _onTap(e.clientX, e.clientY);
            render();
            return;
        }

        const rect         = canvas.getBoundingClientRect();
        const col          = Math.floor((e.clientX - rect.left) / CELL);
        const row          = Math.floor((e.clientY - rect.top + cameraY) / CELL);
        const outsidePitch = e.clientX < rect.left || e.clientX > rect.right
                          || e.clientY < rect.top  || e.clientY > rect.bottom;

        if (outsidePitch && drag.player.col >= 0
                && G.phase === 'setup' && (!NET.online || NET.side === G.setupSide)) {
            // Drag released beyond the pitch boundary → demote to reserve.
            _applyDemote(drag.player);
        } else {
            // Dropped on the pitch — swap with occupant or move to empty cell.
            const occupant = playerAt(G, col, row);
            if (occupant && occupant.id !== drag.player.id && occupant.side === drag.player.side) {
                swapSetupPlayers(G, drag.player.id, occupant.id);
                if (NET.online) sendAction({ type: 'SETUP_PLAYER_SWAP', id1: drag.player.id, id2: occupant.id });
            } else {
                moveSetupPlayer(G, drag.player.id, col, row);
                if (NET.online) sendAction({ type: 'SETUP_MOVE', playerId: drag.player.id, col, row });
            }
            setupErrors = null;
        }
        render();
        return;
    }

    // ── Camera pan end ───────────────────────────────────────────
    if (phase === 'panning') {
        // Dismiss any stale overlay left from before the scroll.
        inspectState = null;
        hideChipTooltip(0);
        render();
        return;
    }

    // ── Tap (short press, no significant movement) ────────────────
    if (phase === 'pressing') {
        _onTap(e.clientX, e.clientY);
    }

    // 'cancelled' requires no action.
}


// ── _onPointerCancel ──────────────────────────────────────────────
// The browser cancelled the pointer (incoming call, system gesture, etc.).
// Abort the gesture cleanly without applying any game action.

function _onPointerCancel() {
    _clearLongPress();
    // Preserve panel-initiated drags — they have their own cancel handler.
    if (setupDrag && !setupDrag.fromPanel) setupDrag = null;
    _gesture = null;
    render();
}


// ── _onPointerLeave ───────────────────────────────────────────────
// Mouse left the canvas with no active captured gesture — clear aim indicators
// so the kick/pass overlays don't linger outside the canvas boundary.

function _onPointerLeave(e) {
    if (e.pointerType !== 'mouse') return;
    if (_gesture) return;  // captured drag in progress — leave state alone
    kickHover    = null;
    passHover    = null;
    ttmHover     = null;
    inspectState = null;
    render();
}


// ── _clearLongPress ────────────────────────────────────────────────
// Cancel the long-press timer if it hasn't fired yet.

function _clearLongPress() {
    if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
}


// ── _onTap ────────────────────────────────────────────────────────
// Resolves a short press (no significant movement) into a game action.
//
// Double-tap on any player shows the info tooltip regardless of phase.
// In targeting states a single tap is delayed 260 ms so a second tap
// can preempt it and show the tooltip instead.

function _onTap(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const px   = clientX - rect.left;
    const py   = clientY - rect.top;

    // If the wheel is open, route the tap into it.
    if (wheelState) { _handleWheelTap(px, py); return; }

    const col = Math.floor(px / CELL);
    const row = Math.floor((py + cameraY) / CELL);
    const now = Date.now();

    const isDoubleTap = now - _lastTapTime < 300
                     && col === _lastTapCol
                     && row === _lastTapRow;
    _lastTapTime = now;
    _lastTapCol  = col;
    _lastTapRow  = row;

    // Double-tap: show the player-info card for any player on either team.
    // Tap empty space to dismiss.
    if (isDoubleTap) {
        if (_pendingTap) { clearTimeout(_pendingTap.timer); _pendingTap = null; }
        const player = playerAt(G, col, row);
        if (player) {
            // Anchor the tooltip above the player's cell, not the cursor position.
            const anchor = {
                clientX: rect.left + (player.col + 0.5) * CELL,
                clientY: rect.top  + (player.row + 0.5) * CELL - cameraY,
            };
            showChipTooltip(anchor, player);
        } else {
            hideChipTooltip(0);
        }
        render();
        return;
    }

    // In states where a tap picks a target (pass, intercept), delay the action
    // by 260 ms so a quick second tap can show the tooltip instead of firing
    // an accidental game action.
    const needsDelay = G.passing === 'targeting' || !!G.interceptionChoice || G.throwTeamMate?.phase === 'targeting';
    if (needsDelay) {
        if (_pendingTap) { clearTimeout(_pendingTap.timer); _pendingTap = null; }
        _pendingTap = { timer: setTimeout(() => {
            _pendingTap  = null;
            inspectState = null;
            hideChipTooltip(0);
            handleClick({ clientX, clientY });
        }, 260) };
        return;
    }

    // Immediate single tap — hand off to the main click handler.
    inspectState = null;
    hideChipTooltip(0);
    handleClick({ clientX, clientY });
}


// ── _onLongPress ──────────────────────────────────────────────────
// Fired after 450 ms of stillness on touch or pen. Opens the action
// wheel for the player under the contact point, if any.

function _onLongPress(clientX, clientY) {
    if (G.phase === 'toss' || G.phase === 'gameover' || G.phase === 'setup') return;
    const rect   = canvas.getBoundingClientRect();
    const px     = clientX - rect.left;
    const py     = clientY - rect.top;
    const col    = Math.floor(px / CELL);
    const row    = Math.floor((py + cameraY) / CELL);
    const player = playerAt(G, col, row);
    if (!player) return;
    G.sel = player;
    if (_openWheel(player, px, py)) { if (_gesture) _gesture.phase = 'cancelled'; render(); }
}


// ── _onContextMenu ────────────────────────────────────────────────
// Desktop right-click: open the action wheel centred on the player cell.
// (Touch uses the long-press timer instead.)

function _onContextMenu(e) {
    e.preventDefault();
    if (G.phase === 'toss' || G.phase === 'gameover' || G.phase === 'setup') return;
    const rect = canvas.getBoundingClientRect();
    const px   = e.clientX - rect.left;
    const py   = e.clientY - rect.top;
    const col  = Math.floor(px / CELL);
    const row  = Math.floor((py + cameraY) / CELL);
    const p    = playerAt(G, col, row);
    if (!p) return;
    G.sel = p;
    inspectState = null;
    // Centre the wheel on the player's cell, not the cursor position.
    const cpx = (p.col + 0.5) * CELL;
    const cpy = (p.row + 0.5) * CELL - cameraY;
    if (_openWheel(p, cpx, cpy)) { if (_gesture) _gesture.phase = 'cancelled'; render(); }
}


// ── _applyDemote ──────────────────────────────────────────────────
// Demotes a player from the pitch to reserve and syncs the network.
// Called whenever any drag (canvas or panel) is released off the pitch.

function _applyDemote(player) {
    demoteToReserve(G, player.id);
    if (NET.online) sendAction({ type: 'SETUP_DEMOTE', playerId: player.id });
    setupErrors = null;
    const dp = document.getElementById('mobile-dugout-panel');
    if (dp) dp.classList.add('hidden');
}


// ── HTML5 Drag-and-Drop (desktop sidebar → pitch) ─────────────────
// The desktop teams list uses the HTML5 drag API (row.draggable = true +
// dragstart). These handlers receive the resulting drop onto the canvas.
// This is an entirely separate event channel from Pointer Events.

function _onCanvasDragOver(e) {
    if (G.phase !== 'setup') return;
    const rect = canvas.getBoundingClientRect();
    const col  = Math.floor((e.clientX - rect.left) / CELL);
    const row  = Math.floor((e.clientY - rect.top + cameraY) / CELL);
    if (isValidSetupSquare(G.setupSide, col, row)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        dragHover = { col, row };
    } else {
        dragHover = null;
    }
    render();
}

function _onCanvasDragLeave() {
    dragHover = null;
    render();
}

function _onCanvasDrop(e) {
    e.preventDefault();
    dragHover = null;
    if (G.phase !== 'setup') { render(); return; }
    const playerId = Number(e.dataTransfer.getData('text/plain'));
    const p = G.players.find(pl => pl.id === playerId);
    if (!p || p.side !== G.setupSide)              { render(); return; }
    if (NET.online && NET.side !== G.setupSide)    { render(); return; }
    const rect     = canvas.getBoundingClientRect();
    const col      = Math.floor((e.clientX - rect.left) / CELL);
    const row      = Math.floor((e.clientY - rect.top + cameraY) / CELL);
    const occupant = playerAt(G, col, row);
    if (occupant && occupant.id !== p.id) {
        swapSetupPlayers(G, p.id, occupant.id);
        if (NET.online) sendAction({ type: 'SETUP_PLAYER_SWAP', id1: p.id, id2: occupant.id });
    } else if (!occupant) {
        moveSetupPlayer(G, p.id, col, row);
        if (NET.online) sendAction({ type: 'SETUP_MOVE', playerId: p.id, col, row });
    }
    setupErrors = null;
    render();
}


// ── handleClick ──────────────────────────────────────────────────
// Processes a resolved tap/click at the given client coordinates.
// Called by _onTap (and the delayed _pendingTap timer).
// Never called directly from DOM events anymore.

function handleClick(event) {
    // Wheel overlay was already handled by _onTap before we got here.
    inspectState = null;

    if (G.phase === 'toss' || G.phase === 'gameover') return;

    // Setup drag/drop is handled in _onPointerUp; only selection happens here.
    if (G.phase === 'setup') return;

    const rect = canvas.getBoundingClientRect();
    const px   = event.clientX - rect.left;
    const py   = event.clientY - rect.top;

    // ── Confirm overlay ──────────────────────────────────────────
    if (G.confirm) {
        const inRect = (r) => r && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
        if (inRect(G.confirm._yesRect)) {
            const cb = G.confirm.onYes;
            G.confirm = null;
            cb();
            render(); return;
        }
        if (inRect(G.confirm._noRect)) {
            const cb = G.confirm.onNo;
            G.confirm = null;
            if (cb) cb();
            render(); return;
        }
        return;  // block all other taps while confirm is open
    }

    // ── Follow-up overlay ────────────────────────────────────────
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
        return;  // block all other taps during follow-up
    }

    // ── Dice overlay — pick a block face ─────────────────────────
    if (G.block && G.block.phase === 'pick-face') {
        const chooser     = G.block.chooser;
        const chooserSide = chooser === 'att' ? G.active
                          : (G.active === 'home' ? 'away' : 'home');
        const isMyPick    = !NET.online || NET.side === chooserSide;
        if (isMyPick) {
            const idx = G.block.rolls.findIndex(f =>
                f._rect &&
                px >= f._rect.x && px <= f._rect.x + f._rect.w &&
                py >= f._rect.y && py <= f._rect.y + f._rect.h
            );
            if (idx >= 0) {
                if (NET.online) sendAction({ type: 'BLOCK_FACE', faceIdx: idx });
                else { const msg = pickBlockFace(G, G.block.rolls[idx]); if (msg) log(msg); }
                render();
                return;
            }
        }
        return;  // block all other taps while dice overlay is open
    }

    const col = Math.floor(px / CELL);
    const row = Math.floor((py + cameraY) / CELL);

    // ── Kick phase — kicker taps an aim square ───────────────────
    if (G.phase === 'kick') {
        const isKicker = !NET.online || NET.side === G.kicker;
        if (isKicker && isValidKickTarget(G.kicker, col, row)) {
            kickHover = null;
            if (NET.online) sendAction({ type: 'KICK_AIM', col, row });
            else { const msg = declareKick(G, col, row); if (msg) log(msg); }
        }
        render();
        return;
    }

    // ── Touchback phase — receiver taps a player ─────────────────
    if (G.phase === 'touchback') {
        const isReceiver = !NET.online || NET.side === G.receiver;
        if (isReceiver) {
            const player = playerAt(G, col, row);
            if (player && player.side === G.receiver) {
                if (NET.online) sendAction({ type: 'TOUCHBACK', playerId: player.id });
                else { const msg = touchbackGiveBall(G, player.id); if (msg) log(msg); }
            }
        }
        render();
        return;
    }

    if (G.phase !== 'play') { render(); return; }

    const player = playerAt(G, col, row);
    if (player) clickPlayer(player);
    else        clickCell(col, row);
    render();
}


// ── _confirmBlock ─────────────────────────────────────────────────
// Opens the confirm overlay showing block odds before committing.

function _confirmBlock(att, def, onConfirm) {
    const { attStr, defStr } = countAssists(G, att, def);
    const { dice, chooser }  = blockDiceCount(attStr, defStr);
    const picker = chooser === 'att' ? 'your pick' : 'their pick';
    G.confirm = {
        prompt: `${dice}d — ${picker}  (ST${attStr} vs ST${defStr})`,
        onYes: onConfirm,
    };
    render();
}


// ── clickPlayer ──────────────────────────────────────────────────

function clickPlayer(player) {
    if (G.block && G.block.phase === 'pick-push') {
        // Chain push: push squares may be occupied — route through clickCell so
        // the push-square validation handles occupied destinations too.
        clickCell(player.col, player.row);
        return;
    }

    G.sel = player;

    // Interception choice — non-active player taps a highlighted interceptor.
    if (G.interceptionChoice && G.interceptionChoice.interceptorIds.includes(player.id)
            && (!NET.online || NET.side !== G.active)) {
        G.confirm = {
            prompt: `Use ${player.name} to intercept?`,
            onYes: () => {
                if (NET.online) sendAction({ type: 'CHOOSE_INTERCEPTOR', playerId: player.id });
                else { const m = chooseInterceptor(G, player.id); if (m) log(m); }
            },
            onNo: null,
        };
        render();
        return;
    }

    // Foul — tap an adjacent prone/stunned enemy while in foul mode.
    if (G.fouling && G.activated && player.side !== G.active
            && (player.status === 'prone' || player.status === 'stunned')
            && isAdjacent(G.activated, player)) {
        if (NET.online) sendAction({ type: 'DO_FOUL', targetId: player.id });
        else { const msg = executeFoul(G, player.id); if (msg) log(msg); }
        render();
        return;
    }

    // Handoff — tap an adjacent standing teammate while carrying the ball.
    if (G.handingOff && G.activated && G.activated.hasBall
            && player.side === G.active && player.id !== G.activated.id
            && isStanding(player) && isAdjacent(G.activated, player)) {
        if (NET.online) sendAction({ type: 'DO_HANDOFF', receiverId: player.id });
        else { const msg = doHandoff(G, player.id); if (msg) log(msg); }
        render();
        return;
    }

    // Animal Savagery — pick an adjacent standing teammate to attack.
    if (G.animalSavagery?.phase === 'pick-target') {
        const asPlayer = G.players.find(pl => pl.id === G.animalSavagery.playerId);
        if (asPlayer && player.side === G.active && player.id !== asPlayer.id
                && isStanding(player) && isAdjacent(asPlayer, player)) {
            if (NET.online) sendAction({ type: 'AS_PICK_TARGET', targetId: player.id });
            else { const msg = resolveASHit(G, player.id); if (msg) log(msg); }
            render();
            return;
        }
    }

    // TTM pick-missile — tap an adjacent standing Right Stuff teammate.
    if (G.throwTeamMate?.phase === 'pick-missile' && G.activated && player.side === G.active
            && player.id !== G.activated.id && player.skills?.includes('Right Stuff')
            && isStanding(player) && isAdjacent(G.activated, player)) {
        if (NET.online) sendAction({ type: 'TTM_PICK_MISSILE', missileId: player.id });
        else { const msg = pickTTMMissile(G, player.id); if (msg) log(msg); }
        render();
        return;
    }

    // TTM targeting — throw to this player's square.
    if (G.throwTeamMate?.phase === 'targeting' && G.activated && player.id !== G.activated.id) {
        ttmHover = null;
        _doTTMThrow(player.col, player.row);
        return;
    }

    // Pass targeting — throw to this player's square.
    if (G.passing === 'targeting' && G.activated && player.id !== G.activated.id) {
        passHover = null;
        _doThrow(player.col, player.row);
        return;
    }

    // PV targeting — tap an adjacent standing enemy.
    if (G.pvTargeting) {
        if (G.activated && player.side !== G.active
                && isAdjacent(G.activated, player) && isStanding(player)) {
            if (NET.online) sendAction({ type: 'PV_EXECUTE', targetId: player.id });
            else { const msg = executePV(G, player.id); if (msg) log(msg); }
        }
        render();
        return;
    }

    // Block targeting — must be adjacent already.
    if (G.block === 'targeting') {
        if (player.side !== G.active && isAdjacent(G.activated, player)) {
            _confirmBlock(G.activated, player, () => {
                if (NET.online) {
                    sendAction({ type: 'BLOCK_START', attId: G.activated.id, defId: player.id });
                    G.block = null;
                } else {
                    const msg = declareBlock(G, G.activated, player);
                    if (msg) log(msg);
                }
            });
        }
        return;
    }

    // Blitz targeting — declare the target, then the player moves freely.
    if (G.blitz === 'targeting') {
        if (player.side !== G.active) {
            if (NET.online) sendAction({ type: 'BLITZ_TARGET', defId: player.id });
            else { const msg = setBlitzTarget(G, player.id); if (msg) log(msg); }
        }
        return;
    }

    // Blitz moving — tap the declared target when adjacent to execute the block.
    if (G.blitz && G.blitz.phase === 'moving' && player.id === G.blitz.def.id) {
        if (isAdjacent(G.activated, player)) {
            _confirmBlock(G.activated, player, () => {
                if (NET.online) sendAction({ type: 'BLITZ_START', attId: G.activated.id, defId: player.id });
                else { const msg = blitzBlock(G, G.activated, player); if (msg) log(msg); }
            });
        }
        return;
    }
}


// ── clickCell ────────────────────────────────────────────────────

function clickCell(col, row) {
    // Push square pick — attacker only.
    if (G.block && G.block.phase === 'pick-push') {
        const isAttacker = !NET.online || NET.side === G.active;
        if (!isAttacker) return;
        const valid = G.block.pushSquares.some(([c, r]) => c === col && r === row);
        if (valid) {
            if (NET.online) sendAction({ type: 'BLOCK_PUSH', col, row });
            else { const msg = pickPushSquare(G, col, row); if (msg) log(msg); }
        }
        return;
    }

    // TTM targeting — any tap resolves the throw.
    if (G.throwTeamMate?.phase === 'targeting' && G.activated) {
        ttmHover = null;
        _doTTMThrow(col, row);
        return;
    }

    // Pass targeting — any tap resolves the throw.
    if (G.passing === 'targeting' && G.activated) {
        passHover = null;
        _doThrow(col, row);
        return;
    }

    if (G.blitz === 'targeting') return;

    // Already activated — just move.
    if (G.activated) {
        const { allowed } = canMoveTo(G, G.activated, col, row);
        if (!allowed) return;
        if (NET.online) sendAction({ type: 'MOVE', col, row });
        else { const msg = movePlayer(G, col, row); if (msg) log(msg); }
        return;
    }

    // Selected but not yet activated — activate-and-move on a highlighted cell.
    if (G.sel && G.sel.side === G.active && !G.sel.usedAction && !G.block && !G.targeting) {
        const { allowed } = canMoveTo(G, G.sel, col, row);
        if (!allowed) return;
        if (NET.online) {
            sendAction({ type: 'ACTIVATE_AND_MOVE', playerId: G.sel.id, col, row });
        } else {
            const activateMsg = activateMover(G, G.sel.id);
            if (activateMsg) log(activateMsg);
            if (G.activated && !G.animalSavagery) {
                const moveMsg = movePlayer(G, col, row);
                if (moveMsg) log(moveMsg);
            }
        }
    }
}


// ── Button handlers ──────────────────────────────────────────────

function onClickSecureBall() {
    if (!G.sel || G.sel.side !== G.active) return;
    if (NET.online) sendAction({ type: 'SECURE_BALL', playerId: G.sel.id });
    else { const msg = secureBall(G, G.sel.id); if (msg) log(msg); render(); }
}

function onClickStandUp() {
    if (!G.sel || G.sel.side !== G.active) return;
    if (G.sel.usedAction || G.activated) return;
    if (G.sel.status !== 'prone') return;
    if (NET.online) sendAction({ type: 'ACTIVATE', playerId: G.sel.id });
    else { const msg = activateMover(G, G.sel.id); if (msg) log(msg); render(); }
}

function onClickBlock() {
    if (!G.sel || G.sel.side !== G.active) return;
    if (G.sel.usedAction || G.activated) return;
    if (G.sel.status !== 'active') return;  // prone/stunned players can't block
    G.activated = G.sel;
    G.block     = 'targeting';
    G.targeting = true;
    log(`${G.sel.name} declares block — click a target`);
    render();
}

function onClickBlitz() {
    if (!G.sel || G.sel.side !== G.active) return;
    if (G.sel.usedAction || G.activated) return;
    if (NET.online) sendAction({ type: 'BLITZ_DECLARE', playerId: G.sel.id });
    else { const msg = activateBlitz(G, G.sel.id); if (msg) log(msg); render(); }
}

// ── _doThrow ──────────────────────────────────────────────────────
// Called when the player taps a target square in throw-targeting mode.
// Checks for interceptors and asks confirmation if any are found.

function _doThrow(col, row) {
    if (!G.activated) return;
    const interceptors = getInterceptors(G, G.activated, col, row);
    const execute = () => {
        passHover = null;
        if (NET.online) sendAction({ type: 'THROW_BALL', col, row });
        else { const msg = throwBall(G, col, row); if (msg) log(msg); }
    };
    if (interceptors.length === 0) {
        execute();
    } else {
        // Show trajectory + interceptors in the overlay while confirm is open.
        passHover = { col, row };
        G.confirm = {
            prompt: 'Confirm throw?',
            onYes: execute,
            onNo:  () => { G.passing = 'targeting'; render(); },
        };
        render();
    }
}

function onClickThrow() {
    if (!G.passing || !G.activated || !G.activated.hasBall) return;
    G.passing   = 'targeting';
    G.targeting = true;
    passHover   = null;
    log(`${G.activated.name} ready to throw — click target square.`);
    render();
}

function onClickNoIntercept() {
    if (!G.interceptionChoice) return;
    if (NET.online) sendAction({ type: 'CHOOSE_INTERCEPTOR', playerId: null });
    else { const msg = chooseInterceptor(G, null); if (msg) log(msg); }
}

function onClickFoul() {
    if (!G.sel || G.sel.side !== G.active) return;
    if (NET.online) sendAction({ type: 'FOUL_DECLARE', playerId: G.sel.id });
    else { const msg = declareFoul(G, G.sel.id); if (msg) log(msg); render(); }
}

function onClickPV() {
    if (!G.sel || G.sel.side !== G.active) return;
    if (NET.online) sendAction({ type: 'PV_DECLARE', playerId: G.sel.id });
    else { const msg = declarePV(G, G.sel.id); if (msg) log(msg); render(); }
}

function onClickTTM() {
    if (!G.sel || G.sel.side !== G.active) return;
    if (NET.online) sendAction({ type: 'TTM_DECLARE', playerId: G.sel.id });
    else { const msg = declareTTM(G, G.sel.id); if (msg) log(msg); render(); }
}

function _doTTMThrow(col, row) {
    if (!G.activated) return;
    if (NET.online) sendAction({ type: 'TTM_THROW', col, row });
    else { const msg = throwTeamMate(G, col, row); if (msg) log(msg); }
}

function onClickHandoff() {
    if (!G.sel || G.sel.side !== G.active) return;
    if (NET.online) sendAction({ type: 'HANDOFF_DECLARE', playerId: G.sel.id });
    else { const msg = declareHandoff(G, G.sel.id); if (msg) log(msg); render(); }
}

function onClickPass() {
    if (!G.sel || G.sel.side !== G.active) return;
    if (NET.online) sendAction({ type: 'PASS_DECLARE', playerId: G.sel.id });
    else { const msg = declarePass(G, G.sel.id); if (msg) log(msg); render(); }
}

function onClickCancel() {
    if (G.throwTeamMate?.phase === 'targeting') {
        G.throwTeamMate    = { phase: 'pick-missile' };
        ttmHover = null;
        log('Missile unselected — pick again or move first.');
        render();
        return;
    }
    if (G.passing === 'targeting') {
        G.passing = true;
        passHover = null;
        log('Throw cancelled — move if needed, then press Throw again.');
        render();
        return;
    }
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
    if (NET.online) sendAction({ type: 'STOP' });
    else { const msg = endActivation(G); if (msg) log(msg); render(); }
}

function onClickConfirmSetup() {
    if (NET.online) { sendAction({ type: 'CONFIRM_SETUP' }); return; }
    const result = confirmSetup(G, G.setupSide);
    if (!result) return;
    if (result.errors) {
        setupErrors = result.errors;
        result.errors.forEach(e => log(e, 'error'));
    } else {
        setupErrors = null;
        log(result.msg);
        scrollToSetupSide();
    }
    render();
}

function onClickEndTurn() {
    G.confirm = {
        prompt: 'End your turn?',
        onYes: () => {
            if (NET.online) sendAction({ type: 'END_TURN' });
            else { endTurn(G); render(); }
        },
    };
    render();
}


// ── updateButtons ────────────────────────────────────────────────

function updateButtons() {
    // Argue the call — fouling team decides whether to challenge the referee.
    const myTurnNow = !NET.online || NET.side === G.active;
    if (G.argueCallPending && !G.confirm
            && (!NET.online || NET.side === G.argueCallPending.side)) {
        G.confirm = {
            prompt: 'Ref spotted the foul! Argue the call?',
            onYes: () => {
                if (NET.online) sendAction({ type: 'ARGUE_CALL', use: true });
                else { const m = resolveArgueCall(G, true);  if (m) log(m); }
            },
            onNo: () => {
                if (NET.online) sendAction({ type: 'ARGUE_CALL', use: false });
                else { const m = resolveArgueCall(G, false); if (m) log(m); }
            },
        };
    }

    // Pass reroll choice — active player decides whether to spend the Pass skill.
    if (G.passRerollChoice && myTurnNow && !G.confirm) {
        const isFumble = G.passRerollChoice.isFumble;
        G.confirm = {
            prompt: isFumble ? 'Fumble — use Pass skill to reroll?' : 'Inaccurate — use Pass skill to reroll?',
            onYes: () => {
                if (NET.online) { G.passRerollChoice = null; sendAction({ type: 'PASS_REROLL', use: true }); }
                else { const m = resolvePassReroll(G, true);  if (m) log(m); }
            },
            onNo: () => {
                if (NET.online) { G.passRerollChoice = null; sendAction({ type: 'PASS_REROLL', use: false }); }
                else { const m = resolvePassReroll(G, false); if (m) log(m); }
            },
        };
    }

    // Team reroll — active coach decides whether to spend a team reroll on a failed roll.
    if (G.pendingReroll && myTurnNow && !G.confirm) {
        const label = G.pendingReroll.label ?? 'roll';
        G.confirm = {
            prompt: `Reroll ${label}? (${G.rerolls?.[G.pendingReroll.side] ?? 0} left)`,
            onYes: () => {
                if (NET.online) { G.pendingReroll = null; sendAction({ type: 'TEAM_REROLL' }); }
                else { const m = useTeamReroll(G); if (m) log(m); }
            },
            onNo: () => {
                if (NET.online) { G.pendingReroll = null; sendAction({ type: 'DECLINE_TEAM_REROLL' }); }
                else { const m = declineTeamReroll(G); if (m) log(m); }
            },
        };
    }

    const gc   = getGameContext(G, G.sel, NET);
    const play = !gc.inSetup && !gc.inSpecial;

    // Stand Firm — defending team decides whether to absorb the push.
    if (gc.canUseStandFirm && !G.confirm) {
        G.confirm = {
            prompt: `${G.block.def.name} — use Stand Firm?`,
            onYes: () => {
                if (NET.online) sendAction({ type: 'STAND_FIRM', use: true });
                else { const m = resolveStandFirm(G, true);  if (m) log(m); }
            },
            onNo: () => {
                if (NET.online) sendAction({ type: 'STAND_FIRM', use: false });
                else { const m = resolveStandFirm(G, false); if (m) log(m); }
            },
        };
    }

    // Fend — defending team may deny the attacker's follow-up.
    if (gc.canUseFend && !G.confirm) {
        G.confirm = {
            prompt: `${G.block.def?.name} — use Fend to deny follow-up?`,
            onYes: () => {
                if (NET.online) sendAction({ type: 'FEND', use: true });
                else { const m = resolveFend(G, true);  if (m) log(m); }
            },
            onNo: () => {
                if (NET.online) sendAction({ type: 'FEND', use: false });
                else { const m = resolveFend(G, false); if (m) log(m); }
            },
        };
    }

    // Strip Ball — attacking team may force a pushed ball carrier to drop the ball.
    if (gc.canUseStripBall && !G.confirm) {
        G.confirm = {
            prompt: `${G.block.att?.name} — use Strip Ball against ${G.block.def?.name}?`,
            onYes: () => {
                if (NET.online) sendAction({ type: 'STRIP_BALL', use: true });
                else { const m = resolveStripBall(G, true);  if (m) log(m); }
            },
            onNo: () => {
                if (NET.online) sendAction({ type: 'STRIP_BALL', use: false });
                else { const m = resolveStripBall(G, false); if (m) log(m); }
            },
        };
    }

    // ── Button visibility — desktop + mobile in one pass ──────────
    const btnDefs = [
        ['btn-throw',         'mobile-btn-throw',         play && gc.canThrow],
        ['btn-no-intercept',  'mobile-btn-no-intercept',  play && gc.canChooseNoIntercept],
        ['btn-cancel',        'mobile-btn-cancel',        play && gc.canCancel],
        ['btn-stop',          'mobile-btn-stop',          play && gc.canStop],
        ['btn-end-turn',      'mobile-btn-end-turn',      play && gc.myTurn && !G.block],
        ['btn-confirm-setup', 'mobile-btn-confirm-setup', gc.canConfirmSetup],
    ];
    btnDefs.forEach(([desk, mob, vis]) => { show(desk, vis); show(mob, vis); });

    // Dynamic button labels.
    if (gc.canConfirmSetup)
        document.getElementById('btn-confirm-setup').textContent =
            `Confirm ${(G.setupSide || '').toUpperCase()} Setup`;
    const btnEnd = document.getElementById('btn-end-turn');
    if (btnEnd && btnEnd.style.display !== 'none')
        btnEnd.textContent = `End ${G.active.toUpperCase()} Turn`;

    // ── Mobile status labels ──────────────────────────────────────
    const activeEl = document.getElementById('mobile-active-label');
    if (activeEl) {
        const side = G.phase === 'setup'     ? G.setupSide
                   : G.phase === 'kick'      ? G.kicker
                   : G.phase === 'touchback' ? G.receiver
                   :                           G.active;
        activeEl.textContent = G.phase === 'touchback' ? 'TOUCHBACK'
                             : G.phase === 'kick'      ? `${(G.kicker || '').toUpperCase()} KICK`
                             :                           (side || '').toUpperCase();
        activeEl.className   = side === 'home' ? 'team-home' : 'team-away';
    }
    const turnEl = document.getElementById('mobile-turn-label');
    if (turnEl)
        turnEl.textContent = G.phase === 'play'     ? `H${G.half} T${G.turn}`
                           : G.phase === 'gameover' ? 'FT' : '';
    const score = G.score || { home: 0, away: 0 };
    const sh = document.getElementById('mobile-score-home');
    const sa = document.getElementById('mobile-score-away');
    if (sh) sh.textContent = score.home;
    if (sa) sa.textContent = score.away;
}


// ── show ─────────────────────────────────────────────────────────
// Shared helper: show or hide a DOM element by id.

function show(id, visible) {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? '' : 'none';
}

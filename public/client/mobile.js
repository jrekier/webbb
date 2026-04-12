// mobile.js
// Touch input and radial action wheel for mobile play.
//
// Requires three call sites in other files (already wired):
//   render.js   render():        drawWheelOverlay();
//   input.js    setupInput():    setupTouch();
//   input.js    updateButtons(): syncMobileHud();

// ── Camera ────────────────────────────────────────────────────────
// cameraY is the vertical scroll offset in pixels into the pitch.
// 0 = top of pitch visible. Clamped in clampCamera().

var cameraY = 0;

function clampCamera() {
    const maxCam = Math.max(0, CELL * ROWS - canvas.height);
    cameraY = Math.max(0, Math.min(maxCam, cameraY));
}

// Scroll so the current setup side's area is visible at the top of screen.
function scrollToSetupSide() {
    if (!G.setupSide) return;
    cameraY = G.setupSide === 'home' ? CELL * 13 : 0;
    clampCamera();
}

// ── Overlay state ─────────────────────────────────────────────────
// wheelState:   null = hidden; object = { actions, cx, cy, rInner, rOuter }
// inspectState: null = hidden; player object to show stats for

var wheelState   = null;
var inspectState = null;

// ── drawInspectOverlay ────────────────────────────────────────────
// Draws a small stats card near the tapped player.
// Measures text first so the card is always wide enough.

function drawInspectOverlay() {
    if (!inspectState || !ctx) return;
    const p = inspectState;

    const fs    = Math.max(8, Math.floor(CELL * 0.19));
    const lineH = fs * 1.65;
    const padX  = 10;
    const padY  = 8;

    const teamRgb = p.colour
        ? `${p.colour[0]},${p.colour[1]},${p.colour[2]}`
        : (p.side === 'home' ? '180,40,40' : '30,70,160');

    // Build lines with their font/colour already set
    const statusColor = {
        prone:    '#ffaa44',
        stunned:  '#cc66ff',
        ko:       '#888888',
        casualty: '#ff4444',
        active:   'rgba(255,255,255,0.35)',
    };
    const statusLabel = {
        prone:    'PRONE',
        stunned:  'STUNNED',
        ko:       'KO',
        casualty: 'CASUALTY',
        active:   p.usedAction ? 'DONE' : `MA ${p.maLeft}/${p.ma}`,
    };

    const bold   = `bold ${fs + 2}px 'IBM Plex Mono', monospace`;
    const normal = `${fs}px 'IBM Plex Mono', monospace`;
    const small  = `${fs - 1}px 'IBM Plex Mono', monospace`;

    const lines = [
        { text: p.name,                                          font: bold,   color: `rgb(${teamRgb})` },
        { text: p.pos,                                           font: small,  color: `rgba(${teamRgb},0.6)` },
        { text: `ST ${p.st}  AG ${p.ag}  PA ${p.pa}  AV ${p.av}`, font: normal, color: 'rgba(255,255,255,0.7)' },
    ];
    if (p.skills && p.skills.length > 0)
        lines.push({ text: p.skills.join(', '), font: small, color: 'rgba(255,255,255,0.5)' });
    if (p.hasBall)
        lines.push({ text: '● BALL CARRIER', font: small, color: '#ffcc00' });
    lines.push({ text: statusLabel[p.status] || p.status.toUpperCase(), font: bold, color: statusColor[p.status] || 'white' });

    // Measure each line to size the card correctly
    let maxW = 0;
    lines.forEach(l => { ctx.font = l.font; maxW = Math.max(maxW, ctx.measureText(l.text).width); });
    const cardW = maxW + padX * 2;
    const cardH = padY * 2 + lines.length * lineH;

    // Float above the player (below if too close to the top edge)
    let cardX = p.col * CELL + CELL / 2 - cardW / 2;
    let cardY = p.row * CELL - cameraY - cardH - 6;
    if (cardY < 0) cardY = p.row * CELL - cameraY + CELL + 6;
    cardX = Math.max(2, Math.min(canvas.width - cardW - 2, cardX));
    cardY = Math.max(2, Math.min(canvas.height - cardH - 2, cardY));

    roundRect(ctx, cardX, cardY, cardW, cardH, 4);
    ctx.fillStyle = 'rgba(8,6,3,0.92)';
    ctx.fill();
    roundRect(ctx, cardX, cardY, cardW, cardH, 4);
    ctx.strokeStyle = `rgba(${teamRgb},0.85)`;
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => {
        ctx.font      = l.font;
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, cardX + padX, cardY + padY + i * lineH);
    });
}

// ── drawWheelOverlay ──────────────────────────────────────────────
// Called at the end of render(). Draws inspect card first, then wheel.

function drawWheelOverlay() {
    drawInspectOverlay();
    if (!wheelState || !ctx) return;
    const { cx, cy, actions, rInner, rOuter } = wheelState;
    const n         = actions.length;
    const sweep     = (Math.PI * 2) / n;
    const baseAngle = -Math.PI / 2;  // 12 o'clock

    // Dim the pitch behind the wheel
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const gap = 0; // radians between segments

    actions.forEach((a, i) => {
        const a0  = baseAngle + i * sweep + gap;
        const a1  = baseAngle + (i + 1) * sweep - gap;
        const mid = (a0 + a1) / 2;

        // True donut segment: outer arc → line → inner arc reversed → close
        ctx.beginPath();
        ctx.arc(cx, cy, rOuter, a0, a1);
        ctx.arc(cx, cy, rInner, a1, a0, true);
        ctx.closePath();
        ctx.fillStyle   = a.bg;
        ctx.fill();
        ctx.strokeStyle = a.color;
        ctx.lineWidth   = 2;
        ctx.stroke();

        // Label centred in the annular slice
        const lx    = cx + Math.cos(mid) * (rInner + rOuter) / 2;
        const ly    = cy + Math.sin(mid) * (rInner + rOuter) / 2;
        const lines = a.label.split('\n');
        ctx.font         = `bold ${Math.max(9, Math.floor(CELL * 0.21))}px 'IBM Plex Mono', monospace`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor  = 'rgba(0,0,0,1)';
        ctx.shadowBlur   = 6;
        ctx.fillStyle    = '#fff';
        lines.forEach((line, li) =>
            ctx.fillText(line, lx, ly + (li - (lines.length - 1) / 2) * CELL * 0.26)
        );
        ctx.shadowBlur = 0;
    });

    // Centre disc (tap to dismiss)
    ctx.beginPath();
    ctx.arc(cx, cy, rInner - 2, 0, Math.PI * 2);
    ctx.fillStyle   = 'rgba(0,0,0,0.65)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth   = 1;
    ctx.stroke();
}

// ── syncMobileHud ─────────────────────────────────────────────────
// Updates the mobile HUD buttons to mirror the current action state.
// Called at the end of updateButtons() in input.js.

function syncMobileHud() {
    const activeEl = document.getElementById('mobile-active-label');
    const turnEl   = document.getElementById('mobile-turn-label');
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
    if (turnEl)
        turnEl.textContent = (G.phase === 'play') ? `H${G.half} T${G.turn}` : G.phase === 'gameover' ? 'FT' : '';

    const score = G.score || { home: 0, away: 0 };
    const sh = document.getElementById('mobile-score-home');
    const sa = document.getElementById('mobile-score-away');
    if (sh) sh.textContent = score.home;
    if (sa) sa.textContent = score.away;

    const gc = getGameContext(G, G.sel, NET);
    mobileShow('mobile-btn-confirm-setup', gc.canConfirmSetup);
    mobileShow('mobile-btn-cancel',        !gc.inSetup && !gc.inSpecial && gc.canCancel);
    mobileShow('mobile-btn-throw',         !gc.inSetup && !gc.inSpecial && gc.canThrow);
    mobileShow('mobile-btn-no-intercept',  !gc.inSetup && !gc.inSpecial && gc.canChooseNoIntercept);
    mobileShow('mobile-btn-stop',          !gc.inSetup && !gc.inSpecial && gc.canStop);
    mobileShow('mobile-btn-end-turn',      !gc.inSetup && !gc.inSpecial && gc.myTurn && !G.block);
}

function mobileShow(id, visible) {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? '' : 'none';
}

// ── toggleMobileLog ───────────────────────────────────────────────
// Opens/closes the log panel. On open, copies current log entries.

function toggleMobileLog() {
    const panel = document.getElementById('mobile-log-panel');
    if (panel.classList.contains('hidden')) {
        const copy = document.getElementById('mobile-log-copy');
        copy.innerHTML = document.getElementById('log').innerHTML;
        copy.scrollTop = copy.scrollHeight;
        panel.classList.remove('hidden');
    } else {
        panel.classList.add('hidden');
    }
}

function toggleMobileDugout() {
    const panel = document.getElementById('mobile-dugout-panel');
    if (panel.classList.contains('hidden')) {
        render();  // ensures mobile-dugout-* containers are freshly populated
        panel.classList.remove('hidden');
    } else {
        panel.classList.add('hidden');
    }
}

// ── setupTouch ────────────────────────────────────────────────────
// Called from setupInput() in input.js.
// On touch devices, replaces click handling with touch handling.

function setupTouch() {
    if (!('ontouchstart' in window)) return;
    // Prevent the synthetic click event that follows touchend
    canvas.removeEventListener('click', handleClick);
    canvas.addEventListener('touchstart', _onTouchStart, { passive: false });
    canvas.addEventListener('touchend',   _onTouchEnd,   { passive: false });
    canvas.addEventListener('touchmove',  _onTouchMove,  { passive: false });
}

var _pressTimer   = null;
var _pressOrigin  = null;
var _dragging     = false;
var _dragCamStart = 0;
var _lastTapTime  = 0;
var _lastTapCol   = -1;
var _lastTapRow   = -1;
var _pendingTap   = null;  // { timer } — delayed single-tap during targeting states

function _onTouchStart(e) {
    e.preventDefault();
    const t = e.touches[0];
    _pressOrigin = { x: t.clientX, y: t.clientY };
    _dragging    = false;

    // Setup phase: immediately pick up a player for drag.
    // Skip if a reserve swap is pending — the tap should complete the swap instead.
    if (G.phase === 'setup' && !pendingSwap) {
        const rect = canvas.getBoundingClientRect();
        const px   = t.clientX - rect.left;
        const py   = t.clientY - rect.top;
        const col  = Math.floor(px / CELL);
        const row  = Math.floor((py + cameraY) / CELL);
        const p    = playerAt(G, col, row);
        if (p) { G.sel = p; render(); }
        if (p && p.side === G.setupSide && (!NET.online || NET.side === G.setupSide)) {
            setupDrag = { player: p, pixelX: px, pixelY: py };
            return;
        }
    }

    _pressTimer = setTimeout(() => {
        _pressTimer = null;
        _onLongPress(_pressOrigin.x, _pressOrigin.y);
    }, 450);
}

function _onTouchMove(e) {
    const t = e.touches[0];

    // Setup drag — move the ghost
    if (setupDrag) {
        const rect       = canvas.getBoundingClientRect();
        setupDrag.pixelX = t.clientX - rect.left;
        setupDrag.pixelY = t.clientY - rect.top;
        render();
        return;
    }

    if (!_pressOrigin) return;
    const dx = t.clientX - _pressOrigin.x;
    const dy = t.clientY - _pressOrigin.y;

    if (!_dragging && dx * dx + dy * dy > 64) {
        if (_pressTimer) { clearTimeout(_pressTimer); _pressTimer = null; }
        _dragging     = true;
        _dragCamStart = cameraY;
    }

    if (_dragging) {
        cameraY = _dragCamStart - dy;
        clampCamera();
        render();
    }
}

function _onTouchEnd(e) {
    e.preventDefault();

    // Setup drag — drop the player
    if (setupDrag) {
        const drag = setupDrag;
        setupDrag  = null;
        const rect = canvas.getBoundingClientRect();
        const t    = e.changedTouches[0];
        const col  = Math.floor((t.clientX - rect.left) / CELL);
        const row  = Math.floor((t.clientY - rect.top + cameraY) / CELL);

        // Double-tap on the same cell: toggle inspect overlay, skip the move.
        const now = Date.now();
        const isDoubleTap = now - _lastTapTime < 300 && col === _lastTapCol && row === _lastTapRow;
        _lastTapTime = now;
        _lastTapCol  = col;
        _lastTapRow  = row;
        if (isDoubleTap && col === drag.player.col && row === drag.player.row) {
            inspectState = inspectState?.id !== drag.player.id ? drag.player : null;
            render();
            _pressOrigin = null;
            return;
        }

        inspectState = null;
        moveSetupPlayer(G, drag.player.id, col, row);  // optimistic update
        if (NET.online) {
            sendAction({ type: 'SETUP_MOVE', playerId: drag.player.id, col, row });
        }
        setupErrors = null;
        render();
        _pressOrigin = null;
        return;
    }

    _dragging = false;
    if (_pressTimer) {
        clearTimeout(_pressTimer);
        _pressTimer = null;

        // Complete a pending reserve swap when tapping a pitch player.
        if (G.phase === 'setup' && pendingSwap) {
            inspectState = null;
            const rect   = canvas.getBoundingClientRect();
            const t      = e.changedTouches[0];
            const col    = Math.floor((t.clientX - rect.left) / CELL);
            const row    = Math.floor((t.clientY - rect.top + cameraY) / CELL);
            const target = playerAt(G, col, row);
            if (target && target.side === G.setupSide && target.col >= 0
                    && (!NET.online || NET.side === G.setupSide)) {
                swapReservePlayer(G, pendingSwap.id, target.id);
                if (NET.online) sendAction({ type: 'SETUP_RESERVE_SWAP', reserveId: pendingSwap.id, pitchId: target.id });
                setupErrors = null;
            }
            pendingSwap = null;
            render();
            _pressOrigin = null;
            return;
        }

        _onTap(_pressOrigin.x, _pressOrigin.y);
    } else {
        // Scroll ended — dismiss any open inspect card.
        inspectState = null;
        render();
    }
    _pressOrigin = null;
}

// ── Tap ───────────────────────────────────────────────────────────

function _onTap(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const px   = clientX - rect.left;
    const py   = clientY - rect.top;

    if (wheelState) {
        _handleWheelTap(px, py);
        return;
    }

    const col = Math.floor(px / CELL);
    const row = Math.floor((py + cameraY) / CELL);
    const now = Date.now();

    const isDoubleTap = now - _lastTapTime < 300 && col === _lastTapCol && row === _lastTapRow;
    _lastTapTime = now;
    _lastTapCol  = col;
    _lastTapRow  = row;

    // Double-tap: always toggle inspect card, cancel any pending single-tap, never act
    if (isDoubleTap && !wheelState && G.phase !== 'touchback') {
        if (_pendingTap) { clearTimeout(_pendingTap.timer); _pendingTap = null; }
        const player = playerAt(G, col, row);
        inspectState = player && inspectState?.id !== player.id ? player : null;
        render();
        return;
    }

    // In states where tapping picks a target, delay the action so a double-tap can cancel it
    const needsDelay = G.passing === 'targeting' || !!G.interceptionChoice;
    if (needsDelay) {
        if (_pendingTap) { clearTimeout(_pendingTap.timer); _pendingTap = null; }
        _pendingTap = { timer: setTimeout(() => {
            _pendingTap  = null;
            inspectState = null;
            handleClick({ clientX, clientY });
        }, 260) };
        return;
    }

    // Immediate single tap in all other states
    inspectState = null;
    handleClick({ clientX, clientY });
}

// ── Long press ────────────────────────────────────────────────────

function _onLongPress(clientX, clientY) {
    const rect   = canvas.getBoundingClientRect();
    const px     = clientX - rect.left;
    const py     = clientY - rect.top;
    const col    = Math.floor(px / CELL);
    const row    = Math.floor((py + cameraY) / CELL);
    const player = playerAt(G, col, row);
    if (!player) return;

    G.sel = player;
    if (_openWheel(player, px, py)) render();
}

// ── _openWheel ────────────────────────────────────────────────────
// Determines available actions for this player and opens the wheel.
// Returns true if the wheel was opened.

function _openWheel(player, px, py) {
    const gc = getGameContext(G, player, NET);

    // Non-active player may tap a highlighted interceptor during interception choice
    const canIntercept = G.interceptionChoice
        && G.interceptionChoice.interceptorIds.includes(player.id)
        && (!NET.online || NET.side !== G.active);

    if (!gc.myTurn && !canIntercept) return false;

    const actions = [];

    if (canIntercept) {
        const pid = player.id;
        actions.push({
            label: 'Inter-\ncept', color: '#ffaa40', bg: 'rgba(160,80,0,0.90)',
            fn: () => {
                if (NET.online) sendAction({ type: 'CHOOSE_INTERCEPTOR', playerId: pid });
                else { const m = chooseInterceptor(G, pid); if (m) log(m); }
            },
        });
    }

    // Active-player actions (only for the team whose turn it is)
    if (gc.myTurn && G.activated && G.activated.id === player.id && !G.block) {
        if (gc.canThrow) {
            actions.push({
                label: 'Throw', color: '#ffe080', bg: 'rgba(120,90,0,0.90)',
                fn: onClickThrow,
            });
        }
        if (gc.canCancel) {
            actions.push({
                label: 'Cancel', color: '#ffd080', bg: 'rgba(130,70,0,0.90)',
                fn: onClickCancel,
            });
        } else if (gc.canStop) {
            actions.push({
                label: 'Stop', color: '#90f090', bg: 'rgba(20,110,20,0.90)',
                fn: onClickStop,
            });
        }
    }
    // Unactivated player on active side — declare actions
    else if (gc.canDeclare) {
        if (gc.selProne) {
            // Prone players: offer Stand Up (activates in place) so they can optionally move after.
            // Tapping a highlighted square directly also works (activate-and-move).
            actions.push({
                label: 'Stand\nUp', color: '#90ccff', bg: 'rgba(30,90,190,0.90)',
                fn: onClickStandUp,
            });
            if (gc.canBlitz)
                actions.push({
                    label: 'Blitz', color: '#ffc060', bg: 'rgba(160,80,0,0.90)',
                    fn: onClickBlitz,
                });
            if (gc.canHandoff)
                actions.push({
                    label: 'Handoff', color: '#b0e8b0', bg: 'rgba(20,100,40,0.90)',
                    fn: onClickHandoff,
                });
            if (gc.canPass)
                actions.push({
                    label: 'Pass', color: '#ffe080', bg: 'rgba(120,90,0,0.90)',
                    fn: onClickPass,
                });
        } else {
            // Standing players move by tapping a highlighted square directly — no Move button needed.
            if (gc.hasTargets)
                actions.push({
                    label: 'Block', color: '#ff9090', bg: 'rgba(160,30,30,0.90)',
                    fn: onClickBlock,
                });
            if (gc.canFoul)
                actions.push({
                    label: 'Foul', color: '#ff9090', bg: 'rgba(120,20,20,0.90)',
                    fn: onClickFoul,
                });
            if (gc.canBlitz)
                actions.push({
                    label: 'Blitz', color: '#ffc060', bg: 'rgba(160,80,0,0.90)',
                    fn: onClickBlitz,
                });
            if (gc.canSecure)
                actions.push({
                    label: 'Secure\nBall', color: '#80ffb0', bg: 'rgba(20,120,60,0.90)',
                    fn: onClickSecureBall,
                });
            if (gc.canHandoff)
                actions.push({
                    label: 'Handoff', color: '#b0e8b0', bg: 'rgba(20,100,40,0.90)',
                    fn: onClickHandoff,
                });
            if (gc.canPass)
                actions.push({
                    label: 'Pass', color: '#ffe080', bg: 'rgba(120,90,0,0.90)',
                    fn: onClickPass,
                });
        }
    }

    if (actions.length === 0) return false;

    inspectState = null;  // wheel takes over, no need for the card
    const rInner = CELL * 0.72;
    const rOuter = CELL * 2.1;
    const cx = Math.max(rOuter, Math.min(canvas.width  - rOuter, px));
    const cy = Math.max(rOuter, Math.min(canvas.height - rOuter, py));

    wheelState = { actions, cx, cy, rInner, rOuter };
    return true;
}

// ── _handleWheelTap ───────────────────────────────────────────────

function _handleWheelTap(px, py) {
    const { cx, cy, actions, rInner, rOuter } = wheelState;
    const dx   = px - cx;
    const dy   = py - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < rInner || dist > rOuter) {
        // Tap centre or outside ring — dismiss without action
        wheelState = null;
        render();
        return;
    }

    // Normalise angle to [0, 2π) with 0 = north, increasing clockwise
    let angle = Math.atan2(dy, dx) + Math.PI / 2;
    if (angle < 0) angle += Math.PI * 2;

    const idx = Math.floor(angle / (Math.PI * 2 / actions.length));
    wheelState = null;
    if (idx >= 0 && idx < actions.length) actions[idx].fn();
    render();
}

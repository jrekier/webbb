// mobile.js
// Camera, mobile HUD, action wheel, and panel-drag for mobile play.
//
// Touch/pointer input on the canvas is handled entirely by input.js via the
// unified Pointer Events layer. This file owns everything else that is mobile-
// specific: camera position, the radial action wheel, player-inspect overlay
// state, reserve-panel drag-to-pitch, and the slide-in log/dugout panels.

// ── Camera ────────────────────────────────────────────────────────────────────
// cameraY is the vertical scroll offset in pixels into the pitch.
// 0 = top of pitch visible. Clamped by clampCamera().

var cameraY = 0;

function clampCamera() {
    const maxCam = Math.max(0, CELL * ROWS - canvas.height);
    cameraY = Math.max(0, Math.min(maxCam, cameraY));
}

// Scroll so the current setup side's end zone is visible at the top of screen.
function scrollToSetupSide() {
    if (!G.setupSide) return;
    cameraY = G.setupSide === 'home' ? CELL * 13 : 0;
    clampCamera();
}

// ── Overlay state ─────────────────────────────────────────────────────────────
// wheelState:   null = hidden; object = { actions, cx, cy, rInner, rOuter }
// inspectState: null = hidden; player object whose stats are shown

var wheelState   = null;
var inspectState = null;

// ── Roster drag-over highlight ────────────────────────────────────────────────
// Highlights whichever player row or demote zone the drag cursor is over so
// the user gets clear drop-target feedback without needing CSS :hover.

var _rosterHoverEl = null;

function updateRosterHover(clientX, clientY) {
    const panel = document.getElementById('roster-panel');
    if (!panel || !panel.classList.contains('visible')) {
        clearRosterHover();
        return;
    }

    const dropEl = document.elementFromPoint(clientX, clientY);
    let newHover = null;
    let el = dropEl;
    while (el && el !== panel) {
        if (el.dataset && (el.dataset.demoteZone || el.dataset.playerId)) {
            newHover = el;
            break;
        }
        el = el.parentElement;
    }

    if (_rosterHoverEl === newHover) return;
    if (_rosterHoverEl) _rosterHoverEl.classList.remove('roster-drag-over');
    _rosterHoverEl = newHover;
    if (_rosterHoverEl) _rosterHoverEl.classList.add('roster-drag-over');
}

function clearRosterHover() {
    if (!_rosterHoverEl) return;
    _rosterHoverEl.classList.remove('roster-drag-over');
    _rosterHoverEl = null;
}

// ── HUD panel toggles ─────────────────────────────────────────────────────────

// Opens/closes the sliding log panel; on open, mirrors the current log entries.
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

// ── Roster panel ──────────────────────────────────────────────────────────────
// The roster panel slides in from the edge nearest the active setup zone.
// Home setup → anchored at screen bottom (short drag up to home's setup rows).
// Away setup → anchored just below the status strip (short drag down to away rows).
// During normal play the panel can be opened/closed via the status strip tap.

function openRosterPanel(side) {
    const panel = document.getElementById('roster-panel');
    if (!panel) return;
    // Home setup zone is at the bottom of the pitch → panel anchors at top.
    // Away setup zone is at the top of the pitch → panel anchors at bottom.
    const classes = ['visible'];
    if (side === 'home') classes.push('from-top');
    // Reserves cannot be brought in during soliddefence (movement only).
    if (G.phase === 'kickoff_soliddefence') classes.push('demote-only');
    panel.className = classes.join(' ');
    const title = document.getElementById('roster-title');
    if (title) {
        const label = G.phase === 'kickoff_soliddefence' ? 'SOLID DEFENCE' : 'DUGOUT';
        title.textContent = side ? `${side.toUpperCase()} ${label}` : label;
    }
    requestAnimationFrame(_applyRosterPitchPadding);
}

function closeRosterPanel() {
    const panel = document.getElementById('roster-panel');
    if (!panel) return;
    panel.classList.remove('visible');
    _applyRosterPitchPadding();
}

// Adjusts #pitch-wrap padding so the canvas never extends behind the roster panel.
// sizePitch() reads the padding via getComputedStyle, so this automatically
// resizes the canvas to the available area.
function _applyRosterPitchPadding() {
    const pw    = document.getElementById('pitch-wrap');
    const panel = document.getElementById('roster-panel');
    if (!pw) return;

    const visible = panel && panel.classList.contains('visible');
    if (!visible) {
        pw.style.paddingTop    = '';
        pw.style.paddingBottom = '';
        sizePitch();
        return;
    }

    const panelH  = panel.getBoundingClientRect().height;
    const fromTop = panel.classList.contains('from-top');

    if (fromTop) {
        pw.style.paddingTop    = panelH + 'px';
        pw.style.paddingBottom = '';
    } else {
        // Panel already includes action-bar clearance in its own padding-bottom,
        // so its measured height covers both the visible roster and the action bar gap.
        pw.style.paddingTop    = '';
        pw.style.paddingBottom = panelH + 'px';
    }
    sizePitch();
}

function toggleRosterPanel() {
    const isSetupLike = G.phase === 'setup' || G.phase === 'kickoff_soliddefence';
    if (!isSetupLike) return;  // roster panel only used during setup
    const panel = document.getElementById('roster-panel');
    if (!panel) return;
    if (panel.classList.contains('visible')) {
        closeRosterPanel();
    } else {
        const side = G.setupSide || G.kicker || 'home';
        openRosterPanel(side);
    }
}

// ── Panel press-drag (promote reserve → pitch during setup) ───────────────────
// Pressing a reserve-row and moving > 8 px immediately fires a drag — no timer
// needed. Pointer Events are used throughout so it works in Firefox DevTools
// touch simulation and is not affected by touchcancel.
//
// State:
//   _panelPressOrigin  { player, clientX, clientY } — set on pointerdown
//   _panelPressAC      AbortController for press-phase listeners
//   _panelPointerAC    AbortController for drag-phase listeners
//   _suppressRowClick  true while a drag is live, blocks the synthetic click

var _panelPressOrigin = null;
var _panelPressAC     = null;
var _suppressRowClick = false;
var _panelPointerAC   = null;

// Called from pointerdown on a reserve row (wired in render.js / updateTeams).
function startPanelPress(player, e) {
    _abortPanelPress();
    _panelPressOrigin = { player, clientX: e.clientX, clientY: e.clientY };
    const sig = (_panelPressAC = new AbortController()).signal;
    window.addEventListener('pointermove', _onPanelPressMove, { signal: sig });
    window.addEventListener('pointerup',   _onPanelPressUp,   { signal: sig });
}

function _abortPanelPress() {
    if (_panelPressAC) { _panelPressAC.abort(); _panelPressAC = null; }
    _panelPressOrigin = null;
}

function _onPanelPressMove(e) {
    if (!_panelPressOrigin) return;
    const dx = e.clientX - _panelPressOrigin.clientX;
    const dy = e.clientY - _panelPressOrigin.clientY;
    if (dx * dx + dy * dy > 64) {   // > 8 px — it's a drag, not a tap
        const player = _panelPressOrigin.player;
        _abortPanelPress();
        _firePanelDrag(player, e.clientX, e.clientY);
    }
}

function _onPanelPressUp() {
    // Short tap — abort and let the row's click handler take over.
    _abortPanelPress();
}

// Transition from press phase to active drag phase.
function _firePanelDrag(player, cx, cy) {
    _suppressRowClick = true;
    const rect = canvas.getBoundingClientRect();
    setupDrag  = { player, pixelX: cx - rect.left, pixelY: cy - rect.top, fromPanel: true };
    _dragMoved = false;
    render();

    _panelPointerAC = new AbortController();
    const sig = _panelPointerAC.signal;
    window.addEventListener('pointermove',   _onPanelPointerMove,   { signal: sig });
    window.addEventListener('pointerup',     _onPanelPointerUp,     { signal: sig });
    window.addEventListener('pointercancel', _onPanelPointerCancel, { signal: sig });
    window.addEventListener('contextmenu',   e => e.preventDefault(), { signal: sig });
}

// Track finger/cursor position and collapse the dugout panel on first movement.
function _onPanelPointerMove(e) {
    if (!setupDrag || !setupDrag.fromPanel) return;
    const rect = canvas.getBoundingClientRect();
    setupDrag.pixelX = e.clientX - rect.left;
    setupDrag.pixelY = e.clientY - rect.top;
    _dragMoved = true;
    if (!setupDrag._panelCollapsed) {
        setupDrag._panelCollapsed = true;
        const panel = document.getElementById('roster-panel');
        if (panel) panel.classList.add('drag-collapsing');
    }
    render();
}

// Drop: attempt swap or placement, then clean up.
function _onPanelPointerUp(e) {
    _abortPanelPointers();
    if (!setupDrag || !setupDrag.fromPanel) return;
    const drag = setupDrag;
    _cleanupPanelDrag();

    const rect = canvas.getBoundingClientRect();
    const col  = Math.floor((e.clientX - rect.left) / CELL);
    const row  = Math.floor((e.clientY - rect.top + cameraY) / CELL);
    _applySetupDrop(drag, col, row);
    render();
}

// Cancelled mid-drag (e.g. call received) — revert silently.
function _onPanelPointerCancel() {
    _cleanupPanelDrag();
    render();
}

function _abortPanelPointers() {
    if (_panelPointerAC) { _panelPointerAC.abort(); _panelPointerAC = null; }
}

function _cleanupPanelDrag() {
    _abortPanelPointers();
    setupDrag = null;
    _suppressRowClick = false;
    const panel = document.getElementById('roster-panel');
    if (panel) { panel.classList.remove('drag-collapsing'); panel.classList.remove('visible'); }
    // Reset so _syncRosterPanel reopens the panel on the next render call.
    _rosterLastPhase = null;
}

// ── Action wheel ──────────────────────────────────────────────────────────────
// _openWheel() is called by input.js on long-press. It reads the game context,
// builds the action list, then sets wheelState so render.js draws the overlay.
// Returns true if the wheel was opened (i.e. there was at least one action).

function _openWheel(player, px, py) {
    const gc = getGameContext(G, player, NET);

    // The non-active side can still tap an interceptor candidate.
    const canIntercept = G.interceptionChoice
        && G.interceptionChoice.interceptorIds.includes(player.id)
        && (!NET.online || NET.side !== G.active);

    if (!gc.myTurn && !canIntercept) return false;

    const actions = [];

    // ── Interception (defender's turn) ────────────────────────────────────────
    if (canIntercept) {
        const pid = player.id;
        actions.push({
            label: 'Inter-\ncept', color: '#f0c000', bg: 'rgba(26,62,140,0.92)',
            fn: () => {
                if (NET.online) sendAction({ type: 'CHOOSE_INTERCEPTOR', playerId: pid });
                else { const m = chooseInterceptor(G, pid); if (m) log(m); }
            },
        });
    }

    // ── Active player (already activated) ────────────────────────────────────
    if (gc.myTurn && G.activated && G.activated.id === player.id && !G.block) {
        if (gc.canThrow)
            actions.push({ label: 'Throw',  color: '#f0c000', bg: 'rgba(26,62,140,0.92)',  fn: onClickThrow  });
        if (gc.canCancel)
            actions.push({ label: 'Cancel', color: 'rgba(240,192,0,0.45)', bg: 'rgba(40,30,15,0.88)',  fn: onClickCancel });
        else if (gc.canStop)
            actions.push({ label: 'Stop',   color: 'rgba(240,192,0,0.45)', bg: 'rgba(40,30,15,0.88)', fn: onClickStop   });
    }
    // ── Unactivated player — declare an action ────────────────────────────────
    else if (gc.canDeclare) {
        if (gc.selProne) {
            // Prone players: offer Stand Up first; they may move after.
            // Tapping a highlighted square directly also activates-and-moves.
            actions.push({ label: 'Stand\nUp', color: '#f0c000', bg: 'rgba(26,62,140,0.92)', fn: onClickStandUp });
            if (gc.canBlitz)   actions.push({ label: 'Blitz',   color: '#f0c000', bg: 'rgba(200,16,46,0.92)',  fn: onClickBlitz   });
            if (gc.canHandoff) actions.push({ label: 'Handoff', color: '#f0c000', bg: 'rgba(26,62,140,0.92)',  fn: onClickHandoff });
            if (gc.canPass)    actions.push({ label: 'Pass',    color: '#f0c000', bg: 'rgba(26,62,140,0.92)',  fn: onClickPass    });
        } else {
            // Standing players: move by tapping a highlighted square — no Move button needed.
            if (gc.hasTargets) actions.push({ label: 'Block',        color: '#f0c000', bg: 'rgba(200,16,46,0.92)',  fn: onClickBlock      });
            if (gc.canFoul)    actions.push({ label: 'Foul',         color: '#f0c000', bg: 'rgba(130,8,20,0.92)',   fn: onClickFoul       });
            if (gc.canBlitz)   actions.push({ label: 'Blitz',        color: '#f0c000', bg: 'rgba(200,16,46,0.92)',  fn: onClickBlitz      });
            if (gc.canSecure)  actions.push({ label: 'Secure\nBall', color: '#f0c000', bg: 'rgba(26,62,140,0.92)',  fn: onClickSecureBall });
            if (gc.canHandoff) actions.push({ label: 'Handoff',      color: '#f0c000', bg: 'rgba(26,62,140,0.92)',  fn: onClickHandoff    });
            if (gc.canPass)    actions.push({ label: 'Pass',         color: '#f0c000', bg: 'rgba(26,62,140,0.92)',  fn: onClickPass       });
        }
    }

    if (actions.length === 0) return false;

    // Wheel takes over — clear any tooltip that's visible.
    inspectState = null;
    hideChipTooltip(0);

    const rInner = CELL * 0.72;
    const rOuter = CELL * 2.1;
    // Keep the wheel entirely within the canvas.
    const cx = Math.max(rOuter, Math.min(canvas.width  - rOuter, px));
    const cy = Math.max(rOuter, Math.min(canvas.height - rOuter, py));

    // If the player has active special skills, add a "Special" entry that
    // swaps the wheel to a second layer. Tapping "Back" in that layer
    // restores the main actions. Both layers share the same cx/cy/radii.
    const specials = _buildSpecialActions(player, gc);
    if (specials.length > 0) {
        let mainSnap;
        actions.push({
            label: 'Special',
            color: '#c080ff',
            bg:    'rgba(60,20,100,0.92)',
            fn: () => {
                const back = {
                    label: 'Back',
                    color: 'rgba(240,192,0,0.45)',
                    bg:    'rgba(40,30,15,0.88)',
                    fn:    () => { wheelState = { actions: mainSnap, cx, cy, rInner, rOuter }; render(); },
                };
                wheelState = { actions: [...specials, back], cx, cy, rInner, rOuter };
                render();
            },
        });
        mainSnap = actions.slice();  // captured after Special is pushed — includes it
    }

    wheelState = { actions, cx, cy, rInner, rOuter };
    return true;
}

// ── _buildSpecialActions ──────────────────────────────────────────────────────
// Returns the action list for the Special wheel layer.
// Add one entry per active special skill as they are implemented.
// Returns an empty array (Special button stays hidden) until at least one
// active skill is present.

function _buildSpecialActions(player, gc) {
    const actions = [];
    if (gc.canDeclarePV)
        actions.push({ label: 'Proj.\nVomit', color: '#80ff60', bg: 'rgba(20,70,20,0.92)', fn: onClickPV });
    if (gc.canDeclareTTM)
        actions.push({ label: 'Throw\nMate', color: '#c0c0ff', bg: 'rgba(40,20,80,0.92)', fn: onClickTTM });
    return actions;
}

// ── _handleWheelTap ───────────────────────────────────────────────────────────
// Called by input.js _onTap() when wheelState is open.
// Maps a tap position to one of the radial slices and fires its action.

function _handleWheelTap(px, py) {
    const { cx, cy, actions, rInner, rOuter } = wheelState;
    const dx   = px - cx;
    const dy   = py - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < rInner || dist > rOuter) {
        // Tap centre or outside the ring — dismiss without action.
        wheelState = null;
        render();
        return;
    }

    // Normalise angle: 0 = north, increasing clockwise (matches drawn segments).
    let angle = Math.atan2(dy, dx) + Math.PI / 2;
    if (angle < 0) angle += Math.PI * 2;

    const idx = Math.floor(angle / (Math.PI * 2 / actions.length));
    wheelState = null;
    if (idx >= 0 && idx < actions.length) actions[idx].fn();
    render();
}

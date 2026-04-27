// render.js
// Reads G and draws the canvas. Never modifies G.

// Cell size in pixels — updated by sizePitch() on resize
var CELL = 32;

// Canvas and 2D drawing context — set up by buildPitch()
var canvas, ctx;

// ── log ──────────────────────────────────────────────────────────
// Supports rich tags: [[side:name]] for players, [[cat:verb]] for actions.
// Categories: home/away → team colors, block → red, foul → dark red,
//             skill → blue, move → dim.
function log(msg, type) {
    const el   = document.getElementById('log');
    const line = document.createElement('div');
    line.className = 'log-line' + (type ? ` ${type}` : '');
    if (msg && msg.includes('[[')) {
        const colorMap = {
            home:  'var(--home)',
            away:  'var(--away)',
            block: '#c8102e',
            foul:  '#8a0818',
            skill: '#1a3e8c',
            move:  'var(--text-dim)',
        };
        const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        line.innerHTML = esc(msg).replace(/\[\[(\w+):([^\]]+)\]\]/g, (_, cat, text) => {
            const color = colorMap[cat] || 'inherit';
            const bold  = (cat === 'home' || cat === 'away') ? 'font-weight:600;' : '';
            return `<span style="color:${color};${bold}">${text}</span>`;
        });
    } else {
        line.textContent = msg;
    }
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
}

// ── buildPitch ───────────────────────────────────────────────────
function buildPitch() {
    canvas = document.getElementById('pitch');
    ctx    = canvas.getContext('2d');
    sizePitch();
    window.addEventListener('resize', sizePitch);
}

function sizePitch() {
    const wrap  = document.getElementById('pitch-wrap');
    const style = getComputedStyle(wrap);
    const maxW  = wrap.clientWidth  - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const maxH  = wrap.clientHeight - parseFloat(style.paddingTop)  - parseFloat(style.paddingBottom);

    if (window.innerWidth <= 500) {
        // Mobile: size by width only — pitch may be taller than the screen
        // and is panned vertically via cameraY (set in mobile.js).
        CELL          = Math.floor(maxW / COLS);
        canvas.width  = CELL * COLS;
        canvas.height = maxH;
        // Re-clamp camera in case CELL changed
        clampCamera();
    } else {
        CELL          = Math.floor(Math.min(maxW / COLS, maxH / ROWS));
        canvas.width  = CELL * COLS;
        canvas.height = CELL * ROWS;
    }
    render();
}

// ── render ───────────────────────────────────────────────────────
var _renderPrevActive = null;
var _renderPrevPhase  = null;

function render() {
    if (!ctx) return;

    // Log a turn-start marker when play begins (kickoff / after TD) or when
    // the active side changes mid-play (end of turn or turnover).
    if (G.phase === 'play') {
        const enteredPlay = _renderPrevPhase !== 'play';
        const sideChanged = !enteredPlay && _renderPrevActive !== null && G.active !== _renderPrevActive;
        if (enteredPlay || sideChanged) {
            log(`Turn ${G.turn} · ${G.active.toUpperCase()}`, 'turn-marker-' + G.active);
        }
        _renderPrevActive = G.active;
    }
    _renderPrevPhase = G.phase;
    const cam = cameraY;

    ctx.save();
    ctx.translate(0, -cam);
    drawPitch();
    if (G.phase === 'setup') {
        drawSetupZones();
    } else if (G.phase === 'kick') {
        drawKickZone();
    } else {
        drawHighlights();
        if (G.phase === 'touchback') drawTouchbackHighlights();
        if (G.testMode && setupDrag) _drawTestDragTarget();
    }
    drawBall();
    drawPlayers();
    flushHlLabels();
    drawPassTargetingOverlay();
    drawTTMTargetingOverlay();
    ctx.restore();

    // Overlays in screen space
    if ((G.phase === 'setup' || G.testMode) && setupDrag) drawSetupDragGhost();
    if (G.phase === 'setup' && setupErrors && setupErrors.length) drawSetupErrorBanner();
    if (G.phase === 'touchback') drawTouchbackMessage();
    updateSidebar();
    updateButtons();
    drawDiceOverlay();
    drawFollowUpOverlay();
    drawConfirmOverlay();
    drawWheelOverlay();
}

// ── drawSetupZones ────────────────────────────────────────────────
// Tints the pitch to show the valid setup zone for the current side.

function drawSetupZones() {
    if (!G.setupSide) return;
    const isHome   = G.setupSide === 'home';
    const validMin = isHome ? 13 : 0;
    const validMax = isHome ? ROWS - 1 : 6;
    const losRow   = isHome ? 13 : 6;

    // Darken opponent's half
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (let r = 0; r < ROWS; r++) {
        if (r < validMin || r > validMax)
            ctx.fillRect(0, r * CELL, COLS * CELL, CELL);
    }

    // Subtle green tint on valid zone
    ctx.fillStyle = 'rgba(60,140,60,0.10)';
    ctx.fillRect(0, validMin * CELL, COLS * CELL, (validMax - validMin + 1) * CELL);

    // Highlight LoS row
    ctx.fillStyle = 'rgba(255,210,0,0.10)';
    ctx.fillRect(0, losRow * CELL, COLS * CELL, CELL);

    // Drop-target highlight when dragging from the sidebar
    if (dragHover) {
        const { col, row } = dragHover;
        const occupied = G.players.some(p => p.col === col && p.row === row);
        ctx.fillStyle   = occupied ? 'rgba(80,180,255,0.18)' : 'rgba(80,220,80,0.15)';
        ctx.fillRect(col * CELL, row * CELL, CELL, CELL);
        ctx.strokeStyle = occupied ? 'rgba(80,180,255,0.9)'  : 'rgba(80,220,80,0.9)';
        ctx.lineWidth   = 2;
        ctx.strokeRect(col * CELL + 1, row * CELL + 1, CELL - 2, CELL - 2);
    }

    // Highlight target cell during drag
    if (setupDrag) {
        const col      = Math.floor(setupDrag.pixelX / CELL);
        const row      = Math.floor((setupDrag.pixelY + cameraY) / CELL);
        const occupant = G.players.find(o => o.id !== setupDrag.player.id && o.col === col && o.row === row);
        const inZone   = isValidSetupSquare(G.setupSide, col, row);
        const willSwap = occupant && occupant.side === setupDrag.player.side;
        ctx.strokeStyle = !inZone || (occupant && !willSwap) ? 'rgba(220,60,60,0.9)'
                        : willSwap                           ? 'rgba(80,180,255,0.9)'
                        :                                      'rgba(80,220,80,0.9)';
        ctx.lineWidth   = 2;
        ctx.strokeRect(col * CELL + 1, row * CELL + 1, CELL - 2, CELL - 2);
    }
}

// ── _drawTestDragTarget ───────────────────────────────────────────
// Highlights the target cell while dragging in test mode (world space).

function _drawTestDragTarget() {
    const col      = Math.floor(setupDrag.pixelX / CELL);
    const row      = Math.floor((setupDrag.pixelY + cameraY) / CELL);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return;
    const occupant = G.players.find(o => (!setupDrag.player || o.id !== setupDrag.player.id) && o.col === col && o.row === row);
    ctx.strokeStyle = occupant ? 'rgba(80,180,255,0.9)' : 'rgba(80,220,80,0.9)';
    ctx.lineWidth   = 2;
    ctx.strokeRect(col * CELL + 1, row * CELL + 1, CELL - 2, CELL - 2);
}

// ── drawSetupDragGhost ────────────────────────────────────────────
// Draws the dragged player as a ghost at the cursor (screen space).

function drawSetupDragGhost() {
    const { isBall, player, pixelX, pixelY } = setupDrag;
    ctx.save();
    ctx.globalAlpha = 0.65;
    if (isBall) {
        ctx.beginPath();
        ctx.arc(pixelX, pixelY, CELL * 0.22, 0, Math.PI * 2);
        ctx.fillStyle   = '#e07020';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth   = 1.5;
        ctx.stroke();
    } else {
        const [r, g, b] = player.colour || [180, 180, 180];
        const radius    = CELL * 0.38;
        ctx.beginPath();
        ctx.ellipse(pixelX, pixelY, radius, radius * 0.75, 0, 0, Math.PI * 2);
        ctx.fillStyle   = `rgb(${r},${g},${b})`;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth   = 1.5;
        ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
}

// ── drawSetupErrorBanner ──────────────────────────────────────────
// Screen-space banner showing why the last confirmSetup was rejected.

function drawSetupErrorBanner() {
    const fh  = Math.max(10, Math.min(15, Math.floor(CELL * 0.36)));
    const bh  = fh * 2.4;
    const txt = setupErrors[0];  // show first error; rest in the log
    ctx.fillStyle = 'rgba(160,30,30,0.85)';
    ctx.fillRect(0, canvas.height - bh, canvas.width, bh);
    ctx.fillStyle    = '#fff';
    ctx.font         = `bold ${fh}px 'IBM Plex Mono', monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, canvas.width / 2, canvas.height - bh / 2);
}


// ── Sidebar ───────────────────────────────────────────────────────
function updateSidebar() {
    // Turn banner
    const lbl = document.getElementById('lbl-active');
    if (G.phase === 'setup') {
        lbl.textContent = `${(G.setupSide || '').toUpperCase()} SETUP`;
        lbl.className   = G.setupSide === 'home' ? 'team-home' : 'team-away';
        document.getElementById('lbl-turn').textContent = '';
    } else if (G.phase === 'kick') {
        lbl.textContent = `${(G.kicker || '').toUpperCase()} KICKS`;
        lbl.className   = G.kicker === 'home' ? 'team-home' : 'team-away';
        document.getElementById('lbl-turn').textContent = '';
    } else if (G.phase === 'touchback') {
        lbl.textContent = 'TOUCHBACK';
        lbl.className   = G.receiver === 'home' ? 'team-home' : 'team-away';
        document.getElementById('lbl-turn').textContent = '';
    } else if (G.phase === 'gameover') {
        const { home, away } = G.score || { home: 0, away: 0 };
        lbl.textContent = home > away ? 'HOME WINS' : away > home ? 'AWAY WINS' : 'DRAW';
        lbl.className   = home > away ? 'team-home' : away > home ? 'team-away' : '';
        document.getElementById('lbl-turn').textContent = 'FT';
    } else {
        lbl.textContent = G.active.toUpperCase();
        lbl.className   = G.active === 'home' ? 'team-home' : 'team-away';
        document.getElementById('lbl-turn').textContent = `H${G.half} T${G.turn}`;
    }

    // Score
    const score = G.score || { home: 0, away: 0 };
    document.getElementById('score-home').textContent = score.home;
    document.getElementById('score-away').textContent = score.away;

    // Rerolls — one dot per remaining reroll (desktop + mobile)
    const rr = G.rerolls || { home: 0, away: 0 };
    const rrHome = '●'.repeat(rr.home);
    const rrAway = '●'.repeat(rr.away);
    document.getElementById('rr-home').textContent        = rrHome;
    document.getElementById('rr-away').textContent        = rrAway;
    document.getElementById('mobile-rr-home').textContent = rrHome;
    document.getElementById('mobile-rr-away').textContent = rrAway;

    updateTeams();
    updatePlayerEditor();
}

// ── updatePlayerEditor ────────────────────────────────────────────
// Syncs the Debug player-editor panel with the currently selected player.

function updatePlayerEditor() {
    const section = document.getElementById('section-player-editor');
    if (!section) return;
    const p = G.testMode ? G.sel : null;
    if (!p) { section.style.display = 'none'; return; }
    section.style.display = '';

    document.getElementById('player-editor-name').textContent =
        `${p.name} (${p.side.toUpperCase()})`;
    document.getElementById('player-editor-stats').textContent =
        `MA${p.ma}  ST${p.st}  AG${p.ag}  AV${p.av}`;

    const chips = document.getElementById('skill-chips');
    chips.innerHTML = '';
    (p.skills || []).forEach(skill => {
        const chip = document.createElement('span');
        chip.className   = 'skill-chip';
        chip.textContent = skill;
        const btn        = document.createElement('button');
        btn.className    = 'skill-chip-remove';
        btn.textContent  = '×';
        btn.title        = `Remove ${skill}`;
        btn.onclick      = () => removeSkillFromSelected(skill);
        chip.appendChild(btn);
        chips.appendChild(chip);
    });

    const sel  = document.getElementById('skill-select');
    const have = new Set(p.skills || []);
    sel.innerHTML = '';
    ALL_SKILLS.filter(s => !have.has(s)).forEach(s => {
        const opt = document.createElement('option');
        opt.value = opt.textContent = s;
        sel.appendChild(opt);
    });
    document.getElementById('player-editor-add').style.display =
        sel.options.length ? '' : 'none';
}

// ── chip tooltip ─────────────────────────────────────────────────
// A single shared floating card, positioned via fixed coordinates so
// it's never clipped by sidebar overflow.  Shown on hover (desktop)
// and on touchstart (tablet/mobile), auto-dismissed on touchend.

var _chipTooltipTimer    = null;
var _chipTooltipPlayerId = null;

function showChipTooltip(anchor, p) {
    clearTimeout(_chipTooltipTimer);
    const tt = document.getElementById('chip-tooltip');

    const isActivated = G.activated && G.activated.id === p.id;
    const teamColor   = p.side === 'home' ? 'var(--home)' : 'var(--away)';

    const statusText = p.usedAction && p.status === 'active' ? 'Done'
                     : p.status === 'prone'    ? 'Prone'
                     : p.status === 'stunned'  ? 'Stunned'
                     : p.status === 'ko'       ? 'KO'
                     : p.status === 'casualty' ? 'Casualty'
                     : p.col < 0              ? 'Reserve'
                     :                          null;

    const maInfo = isActivated
        ? `${p.maLeft} MA \u00b7 ${p.rushLeft} GFI`
        : (G.phase === 'play' && p.col >= 0 && !p.usedAction && p.status === 'active')
          ? `MA ${p.maLeft}`
          : null;

    const skillsHtml = p.skills && p.skills.length
        ? `<div class="ct-skills">${p.skills.map(s => `<span class="ct-skill">${s}</span>`).join('')}</div>`
        : '';

    const stClass    = p.col < 0 ? 'reserve'
                     : (p.usedAction && p.status === 'active') ? 'done'
                     : (p.status || 'active');
    const badgesHtml = [
        statusText ? `<span class="ct-badge ct-st-${stClass}">${statusText}</span>` : '',
        p.hasBall  ? '<span class="ct-badge ct-st-ball">&#9679; Ball</span>'         : '',
        maInfo     ? `<span class="ct-badge ct-st-ma">${maInfo}</span>`              : '',
    ].filter(Boolean).join('');

    tt.innerHTML = `
        <div class="ct-top">
          <div class="ct-sprite-slot"></div>
          <div class="ct-info">
            <div class="ct-name" style="color:${teamColor}">${p.name}</div>
            <div class="ct-pos">${p.pos}</div>
            <div class="ct-stats-grid">
              <span>MA</span><span>ST</span><span>AG</span><span>PA</span><span>AV</span>
              <b>${p.ma}</b><b>${p.st}</b><b>${p.ag}</b><b>${p.pa}</b><b>${p.av}</b>
            </div>
          </div>
        </div>${skillsHtml || badgesHtml ? `
        <div class="ct-bottom">${skillsHtml}${badgesHtml ? `<div class="ct-badges">${badgesHtml}</div>` : ''}</div>` : ''}`;

    tt.querySelector('.ct-sprite-slot').appendChild(_drawMiniSprite(p));
    tt.hidden            = false;
    _chipTooltipPlayerId = p.id;

    // On touch devices CSS pins the card to the bottom; skip JS positioning.
    if ('ontouchstart' in window) return;

    // Desktop: float the card near the anchor point.
    const isEl = typeof anchor?.getBoundingClientRect === 'function';
    let ax, ay, preferAbove;
    if (isEl) {
        const r = anchor.getBoundingClientRect();
        ax = r.left + r.width / 2;  ay = r.bottom;  preferAbove = false;
    } else {
        ax = anchor?.clientX ?? window.innerWidth  / 2;
        ay = anchor?.clientY ?? window.innerHeight / 2;
        preferAbove = true;
    }
    tt.style.left = (ax - 80) + 'px';
    tt.style.top  = '-9999px';
    requestAnimationFrame(() => {
        const tr  = tt.getBoundingClientRect();
        let top   = preferAbove ? ay - tr.height - 16 : ay + 6;
        if  (preferAbove  && top < 8)                                  top = ay + 16;
        if  (!preferAbove && top + tr.height > window.innerHeight - 8) top = ay - tr.height - 6;
        const left = Math.max(8, Math.min(window.innerWidth - tr.width - 8, ax - tr.width / 2));
        tt.style.top  = Math.max(8, top) + 'px';
        tt.style.left = left + 'px';
    });
}

function hideChipTooltip(delay) {
    clearTimeout(_chipTooltipTimer);
    _chipTooltipPlayerId = null;
    if (delay) _chipTooltipTimer = setTimeout(() => hideChipTooltip(0), delay);
    else document.getElementById('chip-tooltip').hidden = true;
}

// ── Mini sprite canvas ────────────────────────────────────────────
// Fixed box size for the sprite canvas in the teams list.
const MINI_H = 24;
const MINI_W = 18;

function _drawMiniSprite(p) {
    const isLying = p.status === 'ko' || p.status === 'prone'
                 || p.status === 'stunned' || p.status === 'casualty';

    const canvas  = document.createElement('canvas');
    canvas.classList.add('player-mini-canvas');

    // Lying players use a wider, shorter box (dimensions swapped)
    canvas.width  = isLying ? MINI_H : MINI_W;
    canvas.height = isLying ? MINI_W : MINI_H;

    // CSS status styling
    if (p.status === 'casualty') {
        canvas.style.filter  = 'grayscale(1)';
        canvas.style.opacity = '0.35';
    } else if (p.status === 'ko') {
        canvas.style.opacity = '0.5';
    }

    _paintMiniSprite(canvas, p, isLying);
    return canvas;
}

function _paintMiniSprite(canvas, p, isLying) {
    const sprite = (typeof getSprite !== 'undefined') ? getSprite(p) : null;
    const ctx2   = canvas.getContext('2d');
    ctx2.clearRect(0, 0, canvas.width, canvas.height);
    ctx2.imageSmoothingEnabled = false;

    if (sprite) {
        const scale = MINI_H / SPRITE_REF_HEIGHT;
        const sw    = Math.round(sprite.width  * scale);
        const sh    = Math.round(sprite.height * scale);

        if (isLying) {
            ctx2.save();
            ctx2.translate(canvas.width / 2, canvas.height / 2);
            ctx2.rotate(Math.PI / 2);
            if (p.status === 'stunned') ctx2.globalAlpha = 0.5;
            ctx2.drawImage(sprite, -sw / 2, -sh / 2, sw, sh);
            ctx2.restore();
        } else {
            ctx2.globalAlpha = (p.usedAction && p.status === 'active') ? 0.65 : 1;
            // Top-aligned so tall sprites never clip the head
            ctx2.drawImage(sprite, (canvas.width - sw) / 2, 0, sw, sh);
        }
    } else {
        // Fallback circle/ellipse while sprite sheet is loading
        const [r, g, b] = p.colour || (p.side === 'home' ? [176, 32, 32] : [26, 58, 153]);
        ctx2.fillStyle  = `rgb(${r},${g},${b})`;
        ctx2.globalAlpha = 0.7;
        ctx2.beginPath();
        if (isLying) ctx2.ellipse(canvas.width / 2, canvas.height / 2, 9, 5, 0, 0, Math.PI * 2);
        else         ctx2.ellipse(canvas.width / 2, canvas.height / 2, 5, 9, 0, 0, Math.PI * 2);
        ctx2.fill();
    }
}

// ── updateTeams ───────────────────────────────────────────────────

function updateTeams() {
    const section   = document.getElementById('section-teams');
    if (!G.players || !G.players.length) { section.hidden = true; return; }
    section.hidden = false;

    const offPitchN    = G.players.filter(p => p.col < 0).length;
    const offPitchHome = G.players.filter(p => p.col < 0 && p.side === 'home').length;
    const offPitchAway = G.players.filter(p => p.col < 0 && p.side === 'away').length;

    // Shared across both buildList() calls so double-tap works in both panels.
    let _rowLastClick = { id: null, time: 0 };

    function buildList(elId) {
        const el = document.getElementById(elId);
        if (!el) return;
        el.innerHTML = '';

        const isSetup = G.phase === 'setup';

        ['home', 'away'].forEach(side => {
            // Dugout shows only off-pitch players: reserves, KO'd, and casualties.
            // On-pitch players are visible on the board and don't need to be listed.
            const group = G.players.filter(p => p.side === side && p.col < 0);

            // Sort: active reserves first (promotable), then KO, then casualties.
            const statusRank = p => {
                if (p.status === 'casualty') return 2;
                if (p.status === 'ko')       return 1;
                return 0;
            };
            const sorted = [...group].sort((a, b) => statusRank(a) - statusRank(b));

            const header = document.createElement('div');
            header.className = 'teams-side-header team-' + side;
            header.textContent = side.toUpperCase();
            el.appendChild(header);

            if (!sorted.length) {
                const empty = document.createElement('div');
                empty.className   = 'dugout-empty';
                empty.textContent = 'empty';
                el.appendChild(empty);
                return;
            }

            sorted.forEach(p => {
                const isAvail    = p.status !== 'ko' && p.status !== 'casualty';
                const canSwap    = isAvail && isSetup && G.setupSide === side
                                && (!NET.online || NET.side === side);
                const isSelected = G.sel && G.sel.id === p.id;

                const row = document.createElement('div');
                row.className = 'player-list-row'
                    + (isSelected ? ' pl-selected' : '')
                    + (canSwap    ? ' pl-swappable' : '')
                    + (isAvail    ? ' pl-reserve'   : '')  // styled as ready-to-promote
;

                // Draggable onto the pitch during setup
                if (isSetup && G.setupSide === side && (!NET.online || NET.side === side)) {
                    row.draggable = true;
                    row.addEventListener('dragstart', e => {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', p.id);
                        const mc = row.querySelector('.player-mini-canvas');
                        if (mc) e.dataTransfer.setDragImage(mc, Math.floor(mc.width / 2), Math.floor(mc.height / 2));
                    });
                    // Mobile panel: drag onto pitch fires as soon as movement is detected.
                    // Desktop sidebar uses the HTML5 dragstart/drop path instead.
                    if (isAvail && elId === 'mobile-teams-list') {
                        row.addEventListener('pointerdown', e => startPanelPress(p, e), { passive: true });
                    }
                }

                row.appendChild(_drawMiniSprite(p));

                const name = document.createElement('span');
                name.className   = 'player-list-name';
                name.textContent = p.name;
                row.appendChild(name);

                if (p.col < 0 && p.pos) {
                    const pos = document.createElement('span');
                    pos.className   = 'player-list-pos';
                    pos.textContent = p.pos;
                    row.appendChild(pos);
                }

                // Dugout players (off-pitch): single tap shows the card immediately.
                // On-pitch players: first tap selects; second tap within 300 ms shows tooltip.
                row.addEventListener('click', e => {
                    // Suppress the synthetic click that follows a panel drag release.
                    if (_suppressRowClick) { _suppressRowClick = false; return; }
                    e.stopPropagation();
                    if (p.col < 0) {
                        showChipTooltip(row, p);
                        setTimeout(() => {
                            document.addEventListener('click', () => hideChipTooltip(0), { once: true, capture: true });
                        }, 0);
                    } else {
                        G.sel = p;
                        const now      = Date.now();
                        const isDouble = now - _rowLastClick.time < 300 && _rowLastClick.id === p.id;
                        _rowLastClick  = { id: p.id, time: now };
                        if (isDouble) showChipTooltip(row, p);
                    }
                    render();
                });

                el.appendChild(row);
            });
        });
    }

    buildList('teams-list');
    buildList('mobile-teams-list');

    // Mobile button — show when the dugout has anyone in it.
    const mBtn = document.getElementById('mobile-dugout-btn');
    if (mBtn) {
        mBtn.style.display = offPitchN ? '' : 'none';
        mBtn.textContent   = `Dugout H:${offPitchHome} A:${offPitchAway}`;
    }
}

// ── Pitch ─────────────────────────────────────────────────────────
function drawPitch() {
    // Horizontal mowed-grass stripes
    for (let r = 0; r < ROWS; r++) {
        ctx.fillStyle = r % 2 === 0 ? '#2a7030' : '#236127';
        ctx.fillRect(0, r * CELL, COLS * CELL, CELL);
    }

    // End zones — theme colors (away=blue, home=red)
    ctx.fillStyle = 'rgba(26,62,140,0.42)';
    ctx.fillRect(0, 0, COLS * CELL, CELL);           // away end zone (row 0)

    ctx.fillStyle = 'rgba(200,16,46,0.38)';
    ctx.fillRect(0, (ROWS - 1) * CELL, COLS * CELL, CELL); // home end zone (row 19)

    // Lines of scrimmage (Sevens: rows 6/13)
    ctx.strokeStyle = 'rgba(240,192,0,0.75)';
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(0, 13 * CELL);
    ctx.lineTo(COLS * CELL, 13 * CELL);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, 7 * CELL);
    ctx.lineTo(COLS * CELL, 7 * CELL);
    ctx.stroke();

    // Wide zone boundary lines (Sevens: cols 2 and 9)
    const scrTop      = 7 * CELL;
    const scrBottom   = 13 * CELL;
    const innerBounds = [2, 9];
    ctx.strokeStyle = 'rgba(240,192,0,0.22)';
    ctx.lineWidth   = 1;
    innerBounds.forEach(c => {
        // Away half: from top of pitch to away LoS
        ctx.beginPath();
        ctx.moveTo(c * CELL, 0);
        ctx.lineTo(c * CELL, scrTop);
        ctx.stroke();
        // Home half: from home LoS to bottom of pitch
        ctx.beginPath();
        ctx.moveTo(c * CELL, scrBottom);
        ctx.lineTo(c * CELL, ROWS * CELL);
        ctx.stroke();
    });

    // Tiny crosses at every grid intersection
    const arm = Math.max(2, Math.floor(CELL * 0.09));
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth   = 1;
    for (let r = 0; r <= ROWS; r++) {
        for (let c = 0; c <= COLS; c++) {
            const x = c * CELL;
            const y = r * CELL;
            ctx.beginPath();
            ctx.moveTo(x - arm, y);
            ctx.lineTo(x + arm, y);
            ctx.moveTo(x, y - arm);
            ctx.lineTo(x, y + arm);
            ctx.stroke();
        }
    }

    // End zone labels
    ctx.font         = `${Math.max(9, Math.floor(CELL * 0.38))}px 'IBM Plex Mono', monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = 'rgba(240,192,0,0.55)';
    ctx.fillText('▲  AWAY END ZONE', COLS * CELL / 2, 0 * CELL + CELL / 2);
    ctx.fillText('▼  HOME END ZONE', COLS * CELL / 2, (ROWS - 1) * CELL + CELL / 2);

    // Coordinate indices — column letters top & bottom, row numbers left & right
    const idxSz = Math.max(6, Math.floor(CELL * 0.21));
    ctx.font      = `bold ${idxSz}px 'IBM Plex Mono', monospace`;
    ctx.fillStyle = 'rgba(240,192,0,0.5)';

    ctx.textAlign = 'center';
    for (let c = 0; c < COLS; c++) {
        const label = String.fromCharCode(65 + c);
        const cx    = c * CELL + CELL / 2;
        ctx.textBaseline = 'top';
        ctx.fillText(label, cx, 2);                      // top edge
        ctx.textBaseline = 'bottom';
        ctx.fillText(label, cx, ROWS * CELL - 2);        // bottom edge
    }

    ctx.textBaseline = 'middle';
    for (let r = 0; r < ROWS; r++) {
        const label = ROWS - r;
        const cy    = r * CELL + CELL / 2;
        ctx.textAlign = 'left';
        ctx.fillText(label, 2, cy);                      // left edge
        ctx.textAlign = 'right';
        ctx.fillText(label, COLS * CELL - 2, cy);        // right edge
    }
}

// ── Highlights ────────────────────────────────────────────────────
function drawHighlights() {
    // Movement highlights — green fill + inset border – orange if rush needed
    // Show for the activated player, or as a preview for a selected-but-not-yet-activated player.
    const canPreview = !NET.online || G.sel?.side === NET.side;
    const mover = G.activated ?? (
        canPreview && G.sel && !G.sel.usedAction && G.sel.side === G.active
        && G.sel.status !== 'stunned' && !G.block ? G.sel : null
    );
    if (mover && G.phase !== 'setup' && !G.block && G.blitz !== 'targeting' && G.passing !== 'targeting' && G.throwTeamMate?.phase !== 'targeting' && !G.interceptionChoice) {
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                const { allowed, needsrush, dodgerolltarget } = canMoveTo(G, mover, c, r);
                if (allowed) {
                    const num = dodgerolltarget > 0 ? `${dodgerolltarget}+` : undefined;
                    if (needsrush) {
                        hlCell(c, r, 'rgba(220,130,30,0.22)', 'rgba(255,160,40,0.6)', false, num);
                    } else {
                        hlCell(c, r, 'rgba(100,180,100,0.20)', 'rgba(100,200,100,0.4)', false, num);
                    }
                }
            }
        }
    }

    // Block targeting — red fill + inset border on valid targets
    if (G.block === 'targeting' && G.activated) {
        getBlockTargets(G, G.activated).forEach(t => {
            hlCell(t.col, t.row, 'rgba(200,80,80,0.22)', 'rgba(200,80,80,0.5)', false);
        });
    }

    // Blitz targeting — orange on all standing enemies (target not yet picked)
    if (G.blitz === 'targeting' && G.activated) {
        G.players.filter(p => p.side !== G.active && isStanding(p)).forEach(t => {
            hlCell(t.col, t.row, 'rgba(220,130,30,0.22)', 'rgba(255,160,40,0.6)', false);
        });
    }

    // Blitz moving — dim orange on declared target; bright when adjacent (clickable)
    if (G.blitz && G.blitz.phase === 'moving') {
        const def = G.blitz.def;
        const adjacent = isAdjacent(G.activated, def);
        const fill   = adjacent ? 'rgba(220,130,30,0.35)' : 'rgba(220,130,30,0.12)';
        const border = adjacent ? 'rgba(255,160,40,0.9)'  : 'rgba(255,160,40,0.3)';
        hlCell(def.col, def.row, fill, border, false);
    }

    // Animal Savagery pick-target — red on adjacent standing teammates
    if (G.animalSavagery?.phase === 'pick-target') {
        const asPlayer = G.players.find(p => p.id === G.animalSavagery.playerId);
        if (asPlayer) {
            G.players.filter(p =>
                p.side === G.active && p.id !== asPlayer.id
                && isStanding(p) && p.col >= 0 && isAdjacent(asPlayer, p)
            ).forEach(t => {
                hlCell(t.col, t.row, 'rgba(220,50,50,0.30)', 'rgba(240,80,80,0.90)', false);
            });
        }
    }

    // TTM pick-missile — purple on adjacent standing Right Stuff teammates
    if (G.throwTeamMate?.phase === 'pick-missile' && G.activated) {
        G.players.filter(p =>
            p.side === G.active && p.id !== G.activated.id
            && p.skills?.includes('Right Stuff') && isStanding(p)
            && isAdjacent(G.activated, p)
        ).forEach(t => {
            hlCell(t.col, t.row, 'rgba(180,80,220,0.25)', 'rgba(200,100,240,0.85)', false);
        });
    }

    // TTM targeting — highlight the selected missile's current square
    if (G.throwTeamMate?.phase === 'targeting' && G.throwTeamMate.missileId) {
        const missile = G.players.find(p => p.id === G.throwTeamMate.missileId);
        if (missile && missile.col >= 0) {
            hlCell(missile.col, missile.row, 'rgba(180,80,220,0.40)', 'rgba(200,100,240,1.0)', false);
        }
    }

    // PV targets — green on adjacent standing enemies
    if (G.pvTargeting && G.activated) {
        G.players.filter(p =>
            p.side !== G.active && isStanding(p) && isAdjacent(G.activated, p)
        ).forEach(t => {
            hlCell(t.col, t.row, 'rgba(80,200,60,0.25)', 'rgba(100,230,70,0.8)', false);
        });
    }

    // Foul targets — dark red on adjacent prone/stunned enemies
    if (G.fouling && G.activated) {
        G.players.filter(p =>
            p.side !== G.active
            && (p.status === 'prone' || p.status === 'stunned')
            && p.col >= 0 && isAdjacent(G.activated, p)
        ).forEach(t => {
            hlCell(t.col, t.row, 'rgba(180,30,30,0.30)', 'rgba(220,50,50,0.8)', false);
        });
    }

    // Handoff targets — cyan on adjacent standing teammates when carrier has ball
    if (G.handingOff && G.activated && G.activated.hasBall) {
        G.players.filter(p =>
            p.side === G.active && p.id !== G.activated.id
            && isStanding(p) && isAdjacent(G.activated, p)
        ).forEach(t => {
            hlCell(t.col, t.row, 'rgba(80,220,200,0.25)', 'rgba(80,220,200,0.7)', false);
        });
    }

    // Push squares — orange for attacker (interactive), dimmer for defender (informational)
    if (G.block && G.block.phase === 'pick-push') {
        const isAttacker = !NET.online || NET.side === G.active;
        G.block.pushSquares.forEach(([c, r]) => {
            if (isAttacker)
                hlCell(c, r, 'rgba(255,200,80,0.22)', 'rgba(255,200,80,0.8)', false);
            else
                hlCell(c, r, 'rgba(255,200,80,0.18)', 'rgba(255,200,80,0.4)', false);
        });
    }
}

// ── hlCell / hlCellLabels ─────────────────────────────────────────
// Draws a highlight on one cell: filled background + inset stroke rect.
// dash=true draws a dashed border.
// text is deferred into _hlLabels so it renders above ball and players.
var _hlLabels = [];

function flushHlLabels() {
    if (!_hlLabels.length) return;
    ctx.save();
    ctx.font = `bold ${Math.round(CELL * 0.42)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 4;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    for (const { x, y, text } of _hlLabels)
        ctx.fillText(text, x, y);
    ctx.restore();
    _hlLabels = [];
}

function hlCell(c, r, fill, stroke, dash, text) {
    const x = c * CELL, y = r * CELL;
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, CELL, CELL);
    if (stroke) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = stroke;
        if (dash) ctx.setLineDash([4, 3]);
        ctx.strokeRect(x + 3, y + 3, CELL - 6, CELL - 6);
        if (dash) ctx.setLineDash([]);
    }
    if (text !== undefined)
        _hlLabels.push({ x: x + CELL / 2, y: y + CELL / 2, text });
}

// ── drawKickZone ──────────────────────────────────────────────────
// Tints the pitch during kick phase: darken kicker's half, highlight valid aim area.

function drawKickZone() {
    if (!G.kicker) return;
    const isHome = G.kicker === 'home';

    // Darken kicker's own half
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (let r = 0; r < ROWS; r++) {
        if (isHome ? r >= 13 : r <= 6)
            ctx.fillRect(0, r * CELL, COLS * CELL, CELL);
    }

    // Subtle yellow tint on valid target area
    ctx.fillStyle = 'rgba(255,210,0,0.07)';
    if (isHome) ctx.fillRect(0, 0,          COLS * CELL, 13 * CELL);
    else        ctx.fillRect(0, 7 * CELL,   COLS * CELL, (ROWS - 7) * CELL);

    // Hover highlight — only shown to the kicking team
    if (kickHover && (!NET.online || NET.side === G.kicker)) {
        const { col, row } = kickHover;
        const valid = isValidKickTarget(G.kicker, col, row);
        ctx.fillStyle   = valid ? 'rgba(255,220,0,0.22)' : 'rgba(200,60,60,0.15)';
        ctx.fillRect(col * CELL, row * CELL, CELL, CELL);
        ctx.strokeStyle = valid ? 'rgba(255,220,0,0.9)'  : 'rgba(200,60,60,0.6)';
        ctx.lineWidth   = 2;
        ctx.strokeRect(col * CELL + 1, row * CELL + 1, CELL - 2, CELL - 2);
    }
}

// ── drawTouchbackHighlights ───────────────────────────────────────
// Gold halo on each receiver player during touchback phase.

function drawTouchbackHighlights() {
    const isReceiver = !NET.online || NET.side === G.receiver;
    if (!isReceiver) return;
    G.players
        .filter(p => p.side === G.receiver && p.col >= 0
                  && p.status !== 'ko' && p.status !== 'casualty')
        .forEach(p => hlCell(p.col, p.row, 'rgba(255,200,0,0.18)', 'rgba(255,200,0,0.85)', false));
}

// ── drawTouchbackMessage ──────────────────────────────────────────
// Screen-space banner shown during touchback.

function drawTouchbackMessage() {
    const isReceiver = !NET.online || NET.side === G.receiver;
    const txt = isReceiver
        ? `TOUCHBACK — click one of your players`
        : `TOUCHBACK — waiting for ${(G.receiver || '').toUpperCase()}…`;

    const fh = Math.max(10, Math.min(16, Math.floor(CELL * 0.38)));
    const bh = fh * 2.2;
    ctx.fillStyle = 'rgba(0,0,0,0.60)';
    ctx.fillRect(0, 0, canvas.width, bh);
    ctx.fillStyle    = '#ffcc00';
    ctx.font         = `bold ${fh}px 'IBM Plex Mono', monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, canvas.width / 2, bh / 2);
}

// ── Ball ──────────────────────────────────────────────────────────
function drawBall() {
    if (G.ball.carrier !== null) return;
    if (G.ball.col < 0) return;  // off-pitch during kick phase
    if (setupDrag && setupDrag.isBall) return;  // drawn as ghost
    const x = G.ball.col * CELL + CELL / 2;
    const y = G.ball.row * CELL + CELL / 2;
    ctx.fillStyle = '#e07020';
    ctx.beginPath();
    ctx.arc(x, y, CELL * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth   = 1.5;
    ctx.stroke();
}

// ── Players ───────────────────────────────────────────────────────
function drawPlayers() {
    // Draw back-to-front by row so lower rows appear on top.
    // Activated (greyed) players get a z-order penalty so their semi-transparent
    // overflow is always covered by active players, even on the same row.
    const zRow = p => p.row + (p.usedAction ? 0.5 : 0);
    const sorted = G.players.slice().sort((a, b) => zRow(a) - zRow(b));
    sorted.forEach(p => {
        if (p.col < 0) return;
        if (setupDrag && setupDrag.player && setupDrag.player.id === p.id) return; // drawn as ghost
        drawPlayer(p);
    });
}

function drawPlayer(p) {
    const cx  = p.col * CELL + CELL / 2;
    const cy  = p.row * CELL + CELL / 2;
    const r   = CELL * 0.38;

    // Try sprite first — falls back to circle if not loaded yet
    const sprite = (typeof getSprite !== 'undefined')
        ? getSprite(p) : null;

    if (sprite) {
        drawPlayerSprite(p, sprite, cx, cy);
    } else {
        drawPlayerCircle(p, cx, cy, r);
    }

    // Selection — corner brackets in team colour, with glow
    if (G.sel && G.sel.id === p.id) {
        const isActivated = G.activated && G.activated.id === p.id;
        const isMidMove   = isActivated && hasMovedYet(G);

        // Colour: team colour normally, yellow when activated, green mid-move
        const teamCol = p.colour
            ? `rgb(${p.colour[0]},${p.colour[1]},${p.colour[2]})`
            : (p.side === 'home' ? '#c8292a' : '#1a4fa0');
        const bracketCol = isMidMove   ? '#44ee44'
                         : isActivated ? '#ffdd00'
                         :               teamCol;

        const bx = p.col * CELL + 2;
        const by = p.row * CELL + 2;
        const bw = CELL - 4;
        const bh = CELL - 4;
        const bl = CELL * 0.25;  // bracket arm length

        ctx.save();
        ctx.strokeStyle = bracketCol;
        ctx.lineWidth   = 2;
        ctx.shadowColor = bracketCol;
        ctx.shadowBlur  = 6;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        // top-left
        ctx.moveTo(bx,      by + bl); ctx.lineTo(bx,      by);      ctx.lineTo(bx + bl, by);
        // top-right
        ctx.moveTo(bx + bw - bl, by); ctx.lineTo(bx + bw, by);      ctx.lineTo(bx + bw, by + bl);
        // bottom-right
        ctx.moveTo(bx + bw, by + bh - bl); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw - bl, by + bh);
        // bottom-left
        ctx.moveTo(bx + bl, by + bh); ctx.lineTo(bx,      by + bh); ctx.lineTo(bx,      by + bh - bl);
        ctx.stroke();
        ctx.restore();
    }

    // Ball indicator — always on top
    if (p.hasBall) {
        ctx.fillStyle = '#f08030';
        ctx.beginPath();
        ctx.arc(cx + r * 0.62, cy - r * 0.62, CELL * 0.16, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth   = 1;
        ctx.stroke();
    }

    // Lost-tackle-zone indicator: faint "?" above the token for BH / RS / AS failures
    if (p.bonedHead || p.reallyStupid || p.animalSavage) {
        ctx.save();
        ctx.font         = `bold ${Math.round(CELL * 0.28)}px sans-serif`;
        ctx.fillStyle    = 'rgba(255,255,255,0.45)';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('?', cx, cy - r * 1.15);
        ctx.restore();
    }
}

// ── drawPlayerSprite ─────────────────────────────────────────────
// Scale is anchored to a reference height so sprites with different natural
// sizes (e.g. Black Orc taller than Lineman) render proportionally.
const SPRITE_REF_HEIGHT = 27;  // px — matches a standard human lineman frame

function drawPlayerSprite(p, sprite, cx, cy) {
    const scale = (CELL * 1.1) / SPRITE_REF_HEIGHT;
    const sw    = Math.round(sprite.width  * scale);
    const sh    = Math.round(sprite.height * scale);
    const sx    = cx - sw / 2;
    const sy    = (p.row + 1) * CELL - sh;

    ctx.imageSmoothingEnabled = false;   // keep pixels crisp
    ctx.globalAlpha = p.usedAction ? 0.45 : 1;

    if (p.status === 'prone' || p.status === 'stunned') {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(Math.PI / 2);
        if (p.status === 'stunned') ctx.globalAlpha *= 0.55;
        ctx.drawImage(sprite, -sw / 2, -sh / 2, sw, sh);
        ctx.restore();
    } else {
        ctx.drawImage(sprite, sx, sy, sw, sh);
    }

    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
}

// ── drawPlayerCircle ─────────────────────────────────────────────
// Fallback when sprites aren't loaded yet.
function drawPlayerCircle(p, cx, cy, r) {
    if (p.status === 'prone' || p.status === 'stunned') {
        const base = p.side === 'home' ? '#882222' : '#224488';
        ctx.fillStyle   = p.usedAction ? '#555' : base;
        ctx.globalAlpha = p.status === 'stunned' ? 0.4 : 0.7;
        ctx.beginPath();
        ctx.ellipse(cx, cy, r, r * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth   = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle    = 'rgba(255,255,255,0.5)';
        ctx.font         = `bold ${Math.max(7, Math.floor(CELL * 0.22))}px monospace`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('▼', cx, cy);
        return;
    }

    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.ellipse(cx + 1, cy + r * 0.6, r * 0.7, r * 0.25, 0, 0, Math.PI * 2);
    ctx.fill();

    const base = p.side === 'home' ? '#cc2222' : '#2244cc';
    ctx.fillStyle = p.usedAction ? '#777' : base;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.arc(cx - r * 0.25, cy - r * 0.25, r * 0.55, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    const label = { Blitzer:'BL', Thrower:'TH', 'Black Orc':'BO' }[p.pos] || 'LN';
    ctx.fillStyle    = p.usedAction ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.9)';
    ctx.font         = `bold ${Math.max(8, Math.floor(CELL * 0.28))}px monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy);
}
// ── drawFollowUpOverlay ───────────────────────────────────────────
// Shows YES / NO buttons for the follow-up decision.
// Only shown to the attacker.

function drawFollowUpOverlay() {
    if (!G.block || G.block.phase !== 'follow-up') return;

    const isAttacker = !NET.online || NET.side === G.active;
    if (!isAttacker) {
        // Defender just sees a dim overlay and waits
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.floor(canvas.width * 0.03)}px 'IBM Plex Mono', monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Opponent deciding follow-up…', canvas.width / 2, canvas.height / 2);
        return;
    }

    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const btnW = Math.min(100, canvas.width * 0.2);
    const btnH = btnW * 0.5;
    const gap  = 20;
    const totalW = btnW * 2 + gap;
    const bx   = (canvas.width - totalW) / 2;
    const by   = canvas.height / 2 - btnH / 2;

    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.floor(btnW * 0.22)}px 'IBM Plex Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('Follow up?', canvas.width / 2, by - 10);

    // YES button
    ctx.fillStyle = 'rgba(26,62,140,0.92)';
    roundRect(ctx, bx, by, btnW, btnH, 6); ctx.fill();
    ctx.strokeStyle = 'rgba(240,192,0,0.8)'; ctx.lineWidth = 2;
    roundRect(ctx, bx, by, btnW, btnH, 6); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText('YES', bx + btnW / 2, by + btnH / 2);

    // NO button
    const nx = bx + btnW + gap;
    ctx.fillStyle = 'rgba(40,30,15,0.88)';
    roundRect(ctx, nx, by, btnW, btnH, 6); ctx.fill();
    ctx.strokeStyle = 'rgba(240,192,0,0.4)'; ctx.lineWidth = 2;
    roundRect(ctx, nx, by, btnW, btnH, 6); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText('NO', nx + btnW / 2, by + btnH / 2);

    // Store click regions
    G.block._yesRect = { x: bx, y: by, w: btnW, h: btnH };
    G.block._noRect  = { x: nx, y: by, w: btnW, h: btnH };
}

// ── drawConfirmOverlay ────────────────────────────────────────────
// Generic YES / NO confirmation overlay.
// Driven by G.confirm = { prompt, onYes, onNo }.

function drawConfirmOverlay() {
    if (!G.confirm) return;

    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const btnW   = Math.min(100, canvas.width * 0.2);
    const btnH   = btnW * 0.5;
    const gap    = 20;
    const totalW = btnW * 2 + gap;
    const bx     = (canvas.width - totalW) / 2;
    const by     = canvas.height / 2 - btnH / 2;

    ctx.fillStyle    = '#fff';
    ctx.font         = `bold ${Math.floor(btnW * 0.22)}px 'IBM Plex Mono', monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(G.confirm.prompt, canvas.width / 2, by - 10);

    // YES button
    ctx.fillStyle = 'rgba(26,62,140,0.92)';
    roundRect(ctx, bx, by, btnW, btnH, 6); ctx.fill();
    ctx.strokeStyle = 'rgba(240,192,0,0.8)'; ctx.lineWidth = 2;
    roundRect(ctx, bx, by, btnW, btnH, 6); ctx.stroke();
    ctx.fillStyle    = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText('YES', bx + btnW / 2, by + btnH / 2);

    // NO button
    const nx = bx + btnW + gap;
    ctx.fillStyle = 'rgba(40,30,15,0.88)';
    roundRect(ctx, nx, by, btnW, btnH, 6); ctx.fill();
    ctx.strokeStyle = 'rgba(240,192,0,0.4)'; ctx.lineWidth = 2;
    roundRect(ctx, nx, by, btnW, btnH, 6); ctx.stroke();
    ctx.fillStyle    = '#fff';
    ctx.fillText('NO', nx + btnW / 2, by + btnH / 2);

    // Store click regions on the confirm object itself
    G.confirm._yesRect = { x: bx,  y: by, w: btnW, h: btnH };
    G.confirm._noRect  = { x: nx,  y: by, w: btnW, h: btnH };
}

// ── drawPassTargetingOverlay ──────────────────────────────────────
// Called at the end of render() when G.passing === 'targeting'.
// Draws per-cell range bands and a hover highlight centered on the passer.

function drawPassTargetingOverlay() {
    if (!G.activated || !ctx) return;
    const p = G.activated;
    const inTargeting        = G.passing === 'targeting' && p.hasBall;
    const inInterceptionChoice = !!G.interceptionChoice;
    if (!inTargeting && !inInterceptionChoice) return;

    // Drawn in world space (inside ctx.save/translate/restore in render()).
    // No cameraY adjustment needed here.

    ctx.save();

    const BANDS = [
        { max: 3,  fill: 'rgba(60,200,80,0.15)',  stroke: 'rgba(60,200,80,0.75)',  label: 'Quick' },
        { max: 6,  fill: 'rgba(220,210,30,0.13)', stroke: 'rgba(220,210,30,0.75)', label: 'Short' },
        { max: 9,  fill: 'rgba(240,130,20,0.13)', stroke: 'rgba(240,130,20,0.75)', label: 'Long'  },
        { max: 99, fill: 'rgba(220,50,50,0.11)',  stroke: 'rgba(220,50,50,0.75)',  label: 'Bomb'  },
    ];

    const fs = Math.max(8, Math.floor(CELL * 0.22));

    // Range bands — only shown while actively targeting, not during interception choice
    if (inTargeting) {
        // Build a dist map for every cell, then fill + draw inter-band borders cell-by-cell
        const distAt = (c, r) => {
            const dx = c - p.col, dy = r - p.row;
            return Math.floor(Math.sqrt(dx * dx + dy * dy));
        };
        const bandOf = dist => BANDS.find(b => dist <= b.max) ?? null;

        // Fill each cell with its band colour
        for (let c = 0; c < COLS; c++) {
            for (let r = 0; r < ROWS; r++) {
                const dist = distAt(c, r);
                if (dist === 0) continue;
                const band = bandOf(dist);
                if (!band) continue;
                ctx.fillStyle = band.fill;
                ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
            }
        }

        // Draw a border on each edge where the band changes
        ctx.lineWidth = 1.5;
        const DIRS = [[1, 0], [0, 1]]; // right edge, bottom edge
        for (let c = 0; c < COLS; c++) {
            for (let r = 0; r < ROWS; r++) {
                const bd = bandOf(distAt(c, r));
                for (const [dc, dr] of DIRS) {
                    const nc = c + dc, nr = r + dr;
                    if (nc >= COLS || nr >= ROWS) continue;
                    const nb = bandOf(distAt(nc, nr));
                    if (bd === nb) continue;
                    // Pick the colour of the outer (higher-dist) band for the border
                    const colour = (nb && (!bd || nb.max > bd.max)) ? nb.stroke : (bd ? bd.stroke : null);
                    if (!colour) continue;
                    ctx.strokeStyle = colour;
                    ctx.beginPath();
                    if (dc === 1) { // vertical edge between c and c+1
                        ctx.moveTo((c + 1) * CELL, r * CELL);
                        ctx.lineTo((c + 1) * CELL, (r + 1) * CELL);
                    } else {        // horizontal edge between r and r+1
                        ctx.moveTo(c * CELL,       (r + 1) * CELL);
                        ctx.lineTo((c + 1) * CELL, (r + 1) * CELL);
                    }
                    ctx.stroke();
                }
            }
        }

        // Band labels — placed just above the topmost cell of each band
        ctx.font         = `bold ${fs}px 'IBM Plex Mono', monospace`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'bottom';
        for (let i = 0; i < 3; i++) {
            const maxDist = BANDS[i].max;
            // Find the topmost row in this band directly above the passer's column
            let labelRow = -1;
            for (let r = 0; r < ROWS; r++) {
                if (distAt(p.col, r) === maxDist) { labelRow = r; break; }
            }
            if (labelRow < 0) continue;
            const ly = labelRow * CELL;
            if (ly < 0 || ly > ROWS * CELL) continue;
            ctx.fillStyle = BANDS[i].stroke;
            ctx.fillText(BANDS[i].label, p.col * CELL + CELL / 2, ly);
        }
    }

    // Determine trajectory endpoints
    let idealTgt = null;  // declared/accurate destination (passer's intended square)
    let actualTgt = null; // post-scatter actual destination (what opponents intercept)

    if (inTargeting && passHover && !(passHover.col === p.col && passHover.row === p.row)) {
        // Pre-throw: only the ideal trajectory is known
        idealTgt  = passHover;
        actualTgt = null; // not yet known
    } else if (inInterceptionChoice) {
        const ic = G.interceptionChoice;
        idealTgt  = { col: ic.declaredCol, row: ic.declaredRow };
        actualTgt = { col: ic.actualCol,   row: ic.actualRow   };
    }

    if (idealTgt || actualTgt) {
        const px0 = p.col * CELL + CELL / 2;
        const py0 = p.row * CELL + CELL / 2;

        // Shared corridor drawing helper — modify color here to restyle both trajectories at once
        const drawTrajectory = (col, row, color) => {
            ctx.save();
            ctx.strokeStyle = color;
            ctx.lineWidth   = CELL * 2;
            ctx.lineCap     = 'round';
            ctx.beginPath();
            ctx.moveTo(px0, py0);
            ctx.lineTo(col * CELL + CELL / 2, row * CELL + CELL / 2);
            ctx.stroke();
            ctx.restore();
        };

        if (idealTgt) {
            const { col: hc, row: hr } = idealTgt;

            // Hover highlight + tooltip (targeting mode only)
            if (inTargeting) {
                const dist = Math.max(Math.abs(hc - p.col), Math.abs(hr - p.row));
                const band = BANDS.find(b => dist <= b.max);
                if (band) {
                    ctx.fillStyle   = band.stroke.replace('0.75', '0.30');
                    ctx.fillRect(hc * CELL, hr * CELL, CELL, CELL);
                    ctx.strokeStyle = band.stroke;
                    ctx.lineWidth   = 2;
                    ctx.strokeRect(hc * CELL, hr * CELL, CELL, CELL);

                    const label = `${band.label} (${dist}sq)`;
                    ctx.font      = `bold ${fs}px 'IBM Plex Mono', monospace`;
                    ctx.textAlign = 'center';
                    const tw      = ctx.measureText(label).width + 8;
                    const tx      = hc * CELL + CELL / 2;
                    const ty      = hr * CELL - fs - 6;
                    ctx.fillStyle = 'rgba(0,0,0,0.72)';
                    ctx.fillRect(tx - tw / 2, ty, tw, fs + 4);
                    ctx.fillStyle    = '#fff';
                    ctx.textBaseline = 'top';
                    ctx.fillText(label, tx, ty + 2);
                }
            }

            // Ideal trajectory — white in targeting mode, blue-white during interception choice
            drawTrajectory(hc, hr,
                inInterceptionChoice ? 'rgba(160,200,255,0.20)' : 'rgba(255,255,255,0.20)');
        }

        // Draw actual (post-scatter) trajectory — same corridor style, orange tint
        if (actualTgt) {
            const { col: ac, row: ar } = actualTgt;
            const isDifferent = ac !== idealTgt?.col || ar !== idealTgt?.row;

            drawTrajectory(ac, ar, 'rgba(255,180,80,0.22)');

            // Mark actual landing square, with an X if different from declared target
            if (isDifferent) {
                ctx.fillStyle   = 'rgba(255,200,50,0.30)';
                ctx.fillRect(ac * CELL, ar * CELL, CELL, CELL);
                ctx.strokeStyle = 'rgba(255,200,50,0.90)';
                ctx.lineWidth   = 2;
                ctx.strokeRect(ac * CELL, ar * CELL, CELL, CELL);
            }

            // Interceptor highlights along the actual trajectory
            const interceptorList = G.players.filter(pl =>
                G.interceptionChoice.interceptorIds.includes(pl.id));
            for (const ip of interceptorList) {
                ctx.fillStyle   = 'rgba(255,140,0,0.35)';
                ctx.fillRect(ip.col * CELL, ip.row * CELL, CELL, CELL);
                ctx.strokeStyle = 'rgba(255,140,0,0.90)';
                ctx.lineWidth   = 2;
                ctx.strokeRect(ip.col * CELL, ip.row * CELL, CELL, CELL);
            }
        } else if (idealTgt && inTargeting) {
            // Targeting mode: show interceptors on ideal trajectory
            const { col: hc, row: hr } = idealTgt;
            const interceptorList = typeof getInterceptors === 'function'
                ? getInterceptors(G, p, hc, hr) : [];
            for (const ip of interceptorList) {
                ctx.fillStyle   = 'rgba(255,140,0,0.35)';
                ctx.fillRect(ip.col * CELL, ip.row * CELL, CELL, CELL);
                ctx.strokeStyle = 'rgba(255,140,0,0.90)';
                ctx.lineWidth   = 2;
                ctx.strokeRect(ip.col * CELL, ip.row * CELL, CELL, CELL);
            }
        }
    }

    ctx.restore();
}

// ── drawTTMTargetingOverlay ───────────────────────────────────────
// Drawn during G.throwTeamMate.phase === 'targeting'.
// Shows Quick/Short range bands and a hover trajectory (purple tint).

function drawTTMTargetingOverlay() {
    if (!G.throwTeamMate || G.throwTeamMate.phase !== 'targeting') return;
    if (!G.activated || !ctx) return;
    const p = G.activated;

    ctx.save();

    const BANDS = [
        { max: 3, fill: 'rgba(160,80,220,0.12)', stroke: 'rgba(180,100,240,0.70)', label: 'Quick' },
        { max: 6, fill: 'rgba(120,50,180,0.10)', stroke: 'rgba(140,60,200,0.65)',  label: 'Short' },
    ];

    const fs = Math.max(8, Math.floor(CELL * 0.22));
    const distAt = (c, r) => Math.floor(Math.sqrt((c - p.col) ** 2 + (r - p.row) ** 2));
    const bandOf = d => BANDS.find(b => d <= b.max) ?? null;

    // Fill range bands
    for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
            const d = distAt(c, r);
            if (d === 0) continue;
            const band = bandOf(d);
            if (!band) continue;
            ctx.fillStyle = band.fill;
            ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
        }
    }

    // Band borders
    ctx.lineWidth = 1.5;
    for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
            const bd = bandOf(distAt(c, r));
            for (const [dc, dr] of [[1, 0], [0, 1]]) {
                const nc = c + dc, nr = r + dr;
                if (nc >= COLS || nr >= ROWS) continue;
                const nb = bandOf(distAt(nc, nr));
                if (bd === nb) continue;
                const colour = (nb && (!bd || nb.max > bd.max)) ? nb.stroke : bd?.stroke;
                if (!colour) continue;
                ctx.strokeStyle = colour;
                ctx.beginPath();
                if (dc === 1) { ctx.moveTo((c+1)*CELL, r*CELL); ctx.lineTo((c+1)*CELL, (r+1)*CELL); }
                else          { ctx.moveTo(c*CELL, (r+1)*CELL); ctx.lineTo((c+1)*CELL, (r+1)*CELL); }
                ctx.stroke();
            }
        }
    }

    // Band labels
    ctx.font = `bold ${fs}px 'IBM Plex Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const band of BANDS) {
        let labelRow = -1;
        for (let r = 0; r < ROWS; r++) {
            if (distAt(p.col, r) === band.max) { labelRow = r; break; }
        }
        if (labelRow < 0) continue;
        const ly = labelRow * CELL;
        if (ly < 0 || ly > ROWS * CELL) continue;
        ctx.fillStyle = band.stroke;
        ctx.fillText(band.label, p.col * CELL + CELL / 2, ly);
    }

    // Hover trajectory
    if (ttmHover && !(ttmHover.col === p.col && ttmHover.row === p.row)) {
        const { col: hc, row: hr } = ttmHover;
        const dist  = distAt(hc, hr);
        const band  = bandOf(dist);

        // Trajectory corridor
        ctx.save();
        ctx.strokeStyle = 'rgba(200,120,255,0.20)';
        ctx.lineWidth   = CELL * 2;
        ctx.lineCap     = 'round';
        ctx.beginPath();
        ctx.moveTo(p.col * CELL + CELL / 2, p.row * CELL + CELL / 2);
        ctx.lineTo(hc * CELL + CELL / 2, hr * CELL + CELL / 2);
        ctx.stroke();
        ctx.restore();

        // Hover cell highlight + range label
        if (band) {
            ctx.fillStyle   = band.stroke.replace('0.70', '0.30').replace('0.65', '0.28');
            ctx.fillRect(hc * CELL, hr * CELL, CELL, CELL);
            ctx.strokeStyle = band.stroke;
            ctx.lineWidth   = 2;
            ctx.strokeRect(hc * CELL, hr * CELL, CELL, CELL);

            const label = `${band.label} (${dist}sq)`;
            ctx.font      = `bold ${fs}px 'IBM Plex Mono', monospace`;
            ctx.textAlign = 'center';
            const tw      = ctx.measureText(label).width + 8;
            const tx      = hc * CELL + CELL / 2;
            const ty      = hr * CELL - fs - 6;
            ctx.fillStyle = 'rgba(0,0,0,0.72)';
            ctx.fillRect(tx - tw / 2, ty, tw, fs + 4);
            ctx.fillStyle    = '#fff';
            ctx.textBaseline = 'top';
            ctx.fillText(label, tx, ty + 2);
        }
    }

    ctx.restore();
}

// ── drawDiceOverlay ───────────────────────────────────────────────
// Shows a simple dice picker overlay on the canvas when G.block
// is in 'pick-face' phase.

function drawDiceOverlay() {
    if (!G.block || G.block === 'targeting' || G.block.phase !== 'pick-face') return;

    const rolls    = G.block.rolls;
    const chooser  = G.block.chooser;
    const chooserSide = chooser === 'att' ? G.active
                      : (G.active === 'home' ? 'away' : 'home');
    const isMyPick = !NET.online || NET.side === chooserSide;

    // Dim the pitch
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw each die as a clickable rectangle
    const dieW   = Math.min(80, canvas.width / (rolls.length + 1));
    const dieH   = dieW * 1.1;
    const totalW = rolls.length * (dieW + 12) - 12;
    let x        = (canvas.width - totalW) / 2;
    const y      = canvas.height / 2 - dieH / 2;

    // Title
    ctx.fillStyle    = '#fff';
    ctx.font         = `bold ${Math.floor(dieW * 0.22)}px 'IBM Plex Mono', monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    const title = isMyPick ? 'Choose a result' : `${chooser.toUpperCase()} is choosing…`;
    ctx.fillText(title, canvas.width / 2, y - 10);

    rolls.forEach((face, i) => {
        const dx = x + i * (dieW + 12);

        // Die background — red for bad, dark neutral for mixed, blue for good
        const bg = face.id === 'ATT_DOWN'  ? 'rgba(200,16,46,0.92)'
                 : face.id === 'BOTH_DOWN' ? 'rgba(40,30,15,0.88)'
                 : face.id === 'PUSH'      ? '#e8e0c8'
                 :                           'rgba(26,62,140,0.92)';

        ctx.fillStyle = bg;
        roundRect(ctx, dx, y, dieW, dieH, 6);
        ctx.fill();

        // Border — bright if clickable, dim if not
        ctx.strokeStyle = isMyPick ? 'rgba(240,192,0,0.85)' : 'rgba(240,192,0,0.2)';
        ctx.lineWidth   = isMyPick ? 2 : 1;
        roundRect(ctx, dx, y, dieW, dieH, 6);
        ctx.stroke();

        // Dim the whole die if not my pick
        if (!isMyPick) {
            ctx.fillStyle = 'rgba(0,0,0,0.35)';
            roundRect(ctx, dx, y, dieW, dieH, 6);
            ctx.fill();
        }

        // Label
        const textColor = face.id === 'PUSH' ? '#2a1f0e' : '#ffffff';
        ctx.fillStyle    = textColor;
        ctx.font         = `bold ${Math.floor(dieW * 0.18)}px 'IBM Plex Mono', monospace`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        const lines = face.label.split('\n');
        lines.forEach((line, li) => {
            const lineY = y + dieH / 2 + (li - (lines.length - 1) / 2) * dieW * 0.22;
            ctx.fillText(line, dx + dieW / 2, lineY);
        });

        // Store click region for handleClick to detect
        face._rect = { x: dx, y, w: dieW, h: dieH };
    });
}

// ── roundRect ─────────────────────────────────────────────────────
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

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

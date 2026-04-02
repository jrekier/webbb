// render.js
// Reads G and draws the canvas. Never modifies G.

// ── log ──────────────────────────────────────────────────────────
function log(msg, type) {
    const el   = document.getElementById('log');
    const line = document.createElement('div');
    line.className   = 'log-line' + (type ? ` ${type}` : '');
    line.textContent = msg;
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
function render() {
    if (!ctx) return;
    const cam = cameraY;

    // Pitch, highlights, ball and players are drawn in camera space
    ctx.save();
    ctx.translate(0, -cam);
    drawPitch();
    drawHighlights();
    drawBall();
    drawPlayers();
    ctx.restore();

    // Overlays are always in screen space
    updateSidebar();
    updateButtons();
    drawDiceOverlay();
    drawFollowUpOverlay();
    drawWheelOverlay();
}

// ── Sidebar ───────────────────────────────────────────────────────
function updateSidebar() {
    // Turn banner
    const lbl = document.getElementById('lbl-active');
    lbl.textContent = G.active.toUpperCase();
    lbl.className   = G.active === 'home' ? 'team-home' : 'team-away';
    document.getElementById('lbl-turn').textContent = G.turn;

    updateRoster('roster-home', 'home');
    updateRoster('roster-away', 'away');
    updateDetail();
}

function updateRoster(id, side) {
    const el = document.getElementById(id);
    el.innerHTML = '';
    G.players.filter(p => p.side === side).forEach(p => {
        const row  = document.createElement('div');
        row.className = 'player-row'
            + (G.sel && G.sel.id === p.id ? ' selected' : '')
            + (p.usedAction ? ' done' : '');

        const dot  = document.createElement('div');
        dot.className = `player-dot dot-${side}`;

        const name = document.createElement('span');
        name.className   = 'player-name';
        name.textContent = p.pos;

        const ma = document.createElement('span');
        ma.className   = 'player-ma';
        ma.textContent = `${p.maLeft}/${p.ma}`;

        row.append(dot, name, ma);
        row.addEventListener('click', () => { G.sel = p; render(); });
        el.appendChild(row);
    });

    // Load team button in the section title
    const titleId = side === 'home' ? 'lbl-home-team' : 'lbl-away-team';
    const title   = document.getElementById(titleId);
    if (title && !title.querySelector('.load-btn')) {
        const btn = document.createElement('span');
        btn.className   = 'load-btn';
        btn.textContent = ' ✎';
        btn.title       = 'Load team from JSON';
        btn.style.cssText = 'cursor:pointer;color:var(--text-dim);font-size:9px;';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onLoadTeam(side);
        });
        title.appendChild(btn);
    }
}

function updateDetail() {
    const el = document.getElementById('detail');
    if (!G.sel) {
        el.innerHTML = '<span style="color:#aaa;font-size:10px;">Click a player.</span>';
        return;
    }
    const p           = G.sel;
    const isActivated = G.activated && G.activated.id === p.id;
    const color       = p.side === 'home' ? 'var(--home)' : 'var(--away)';

    const statusClass = p.usedAction ? 'status-done'
                      : isActivated  ? 'status-moving'
                      :                'status-ready';
    const statusText  = p.usedAction ? 'Done'
                      : isActivated  ? `Moving · ${p.maLeft} left`
                      :                'Ready';

    el.innerHTML = `
        <div class="name" style="color:${color}">${p.pos}</div>
        <div class="stat-row">MA <b>${p.ma}</b> &nbsp; Left <b>${p.maLeft}</b></div>
        <div class="stat-row">${p.side.toUpperCase()}</div>
        <span class="status ${statusClass}">${statusText}</span>
    `;
}

// ── Buttons ───────────────────────────────────────────────────────
function updateButtons() {
    const myTurn     = !NET.online || NET.side === G.active;
    const canDeclare = myTurn && G.sel && G.sel.side === G.active
                    && !G.sel.usedAction && !G.activated;

    show('btn-move',     canDeclare);
    show('btn-cancel',   myTurn && G.activated && !hasMovedYet(G));
    show('btn-stop',     myTurn && G.activated &&  hasMovedYet(G));
    show('btn-end-turn', myTurn);

    document.getElementById('btn-end-turn').textContent =
        `End ${G.active.toUpperCase()} Turn`;
}

function show(id, visible) {
    document.getElementById(id).style.display = visible ? '' : 'none';
}

// ── Pitch ─────────────────────────────────────────────────────────
function drawPitch() {
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            ctx.fillStyle = (r + c) % 2 === 0 ? '#2d6e2d' : '#286028';
            ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
        }
    }

    const rs = RULESET;

    // End zones — 1 row deep in 7s, 2 rows in classic
    const awayRows = Array.isArray(rs.END_ZONE_AWAY)
        ? rs.END_ZONE_AWAY : [rs.END_ZONE_AWAY];
    const homeRows = Array.isArray(rs.END_ZONE_HOME)
        ? rs.END_ZONE_HOME : [rs.END_ZONE_HOME];

    ctx.fillStyle = 'rgba(20,20,100,0.30)';
    awayRows.forEach(r =>
        ctx.fillRect(0, r * CELL, COLS * CELL, CELL));

    ctx.fillStyle = 'rgba(100,20,20,0.30)';
    homeRows.forEach(r =>
        ctx.fillRect(0, r * CELL, COLS * CELL, CELL));

    // Lines of scrimmage — drawn at the boundary between the two LoS rows
    // In 7s: home LoS = row 13 top edge, away LoS = row 6 bottom edge
    // The gap between them is the centre field
    ctx.strokeStyle = 'rgba(255,210,0,0.5)';
    ctx.lineWidth   = 2;
    // Home LoS: top edge of SCR_HOME row
    ctx.beginPath();
    ctx.moveTo(0, rs.SCR_HOME * CELL);
    ctx.lineTo(COLS * CELL, rs.SCR_HOME * CELL);
    ctx.stroke();
    // Away LoS: bottom edge of SCR_AWAY row
    ctx.beginPath();
    ctx.moveTo(0, (rs.SCR_AWAY + 1) * CELL);
    ctx.lineTo(COLS * CELL, (rs.SCR_AWAY + 1) * CELL);
    ctx.stroke();

    // Wide zone boundary lines — one line per side, at the inner edge
    // For WIDE_COLS [0,1,9,10]: draw at col 2 (left) and col 9 (right)
    const scrTop      = (rs.SCR_AWAY + 1) * CELL;
    const scrBottom   = rs.SCR_HOME * CELL;
    const wideCols    = rs.WIDE_COLS || [];
    const leftCols    = wideCols.filter(c => c < COLS / 2);
    const rightCols   = wideCols.filter(c => c >= COLS / 2);
    const innerBounds = [];
    if (leftCols.length)  innerBounds.push(Math.max(...leftCols) + 1);
    if (rightCols.length) innerBounds.push(Math.min(...rightCols));
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
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

    // End zone labels
    ctx.font         = `${Math.max(9, Math.floor(CELL * 0.38))}px 'IBM Plex Mono', monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = 'rgba(255,255,255,0.22)';
    ctx.fillText('▲  AWAY END ZONE', COLS * CELL / 2, awayRows[0] * CELL + CELL / 2);
    ctx.fillText('▼  HOME END ZONE', COLS * CELL / 2, homeRows[0] * CELL + CELL / 2);
}

// ── Highlights ────────────────────────────────────────────────────
function drawHighlights() {
    // Movement highlights — green fill + inset border – orange if rush needed
    if (G.activated && !G.block && G.blitz !== 'targeting') {
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                const { allowed, needsrush, dodgerolltarget } = canMoveTo(G, G.activated, c, r);
                if (allowed) {
                    if (needsrush) {
                        hlCell(c, r, 'rgba(220,130,30,0.22)', 'rgba(255,160,40,0.6)', false);
                    }                    
                    if (dodgerolltarget>0){
                        hlCell(c, r, 'rgba(192, 49, 232, 0.22)', 'rgba(244, 40, 255, 0.6)', false, dodgerolltarget);
                    }
                    else {
                        hlCell(c, r, 'rgba(100,180,100,0.20)', 'rgba(100,200,100,0.4)', false);
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

    // Push squares — orange, solid border for attacker, dim for defender
    if (G.block && G.block.phase === 'pick-push') {
        const isAttacker = !NET.online || NET.side === G.active;
        G.block.pushSquares.forEach(([c, r]) => {
            if (isAttacker)
                hlCell(c, r, 'rgba(255,200,80,0.22)', 'rgba(255,200,80,0.8)', false);
            else
                hlCell(c, r, 'rgba(255,200,80,0.08)', null, false);
        });
    }
}

// ── hlCell ────────────────────────────────────────────────────────
// Draws a highlight on one cell: filled background + inset stroke rect.
// dash=true draws a dashed border.
// text is an optional string printed inside the cell
function hlCell(c, r, fill, stroke, dash, text) {
    const x = c * CELL, y = r * CELL;
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, CELL, CELL);
    if (stroke) {
        // ctx.strokeStyle = stroke;
        ctx.lineWidth   = 1;
        if (text !== undefined) {
            ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
            ctx.strokeText(text, x + CELL/2, y + CELL/2);
        }
        ctx.strokeStyle = stroke;
        if (dash) ctx.setLineDash([4, 3]);
        ctx.strokeRect(x + 3, y + 3, CELL - 6, CELL - 6);
        if (dash) ctx.setLineDash([]);
    }
}

// ── Ball ──────────────────────────────────────────────────────────
function drawBall() {
    if (G.ball.carrier !== null) return;
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
    G.players.forEach(p => { if (p.col >= 0) drawPlayer(p); });
}

function drawPlayer(p) {
    const cx  = p.col * CELL + CELL / 2;
    const cy  = p.row * CELL + CELL / 2;
    const r   = CELL * 0.38;

    // Try sprite first — falls back to circle if not loaded yet
    const sprite = (typeof getSprite !== 'undefined')
        ? getSprite(p) : null;

    if (sprite) {
        drawPlayerSprite(p, sprite, cx, cy, r);
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
}

// ── drawPlayerSprite ─────────────────────────────────────────────
function drawPlayerSprite(p, sprite, cx, cy) {
    const scale = (CELL * 1.1) / sprite.height;
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
    ctx.fillStyle = '#2a6a2a';
    roundRect(ctx, bx, by, btnW, btnH, 6); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2;
    roundRect(ctx, bx, by, btnW, btnH, 6); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText('YES', bx + btnW / 2, by + btnH / 2);

    // NO button
    const nx = bx + btnW + gap;
    ctx.fillStyle = '#6a2a2a';
    roundRect(ctx, nx, by, btnW, btnH, 6); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2;
    roundRect(ctx, nx, by, btnW, btnH, 6); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText('NO', nx + btnW / 2, by + btnH / 2);

    // Store click regions
    G.block._yesRect = { x: bx, y: by, w: btnW, h: btnH };
    G.block._noRect  = { x: nx, y: by, w: btnW, h: btnH };
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

        // Die background — warm for positive, red for bad
        const bg = face.id === 'ATT_DOWN'  ? '#aa2222'
                 : face.id === 'BOTH_DOWN' ? '#884400'
                 : face.id === 'PUSH'      ? '#e8e0c8'
                 :                           '#2a6a2a';

        ctx.fillStyle = bg;
        roundRect(ctx, dx, y, dieW, dieH, 6);
        ctx.fill();

        // Border — bright if clickable, dim if not
        ctx.strokeStyle = isMyPick ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.2)';
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

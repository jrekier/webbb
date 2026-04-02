// sprites.js
// Builds tinted player sprites from the coordinates stored on each player object.
//
// Each player has:
//   p.sprite = {
//       sheet:  'assets/sprites/foo.gif',
//       base:   { x, y, w, h },   — skin/outline layer, drawn as-is
//       armour: { x, y, w, h },   — armour layer, tinted with team colour
//   }
//   p.colour = [r, g, b]
//
// base and armour may have different sizes and positions within the sheet.
// Sprites are cached by sheet + base coords + colour.

// ── Sheet cache ───────────────────────────────────────────────────
// Loaded Image objects, keyed by URL.
var sheetCache  = {};

// ── Sprite cache ──────────────────────────────────────────────────
// Built OffscreenCanvas objects, keyed by 'sheet|y|r,g,b'.
var spriteCache = {};

// ── loadSheet ─────────────────────────────────────────────────────
// Loads a sprite sheet image if not already loaded.
// Calls onLoad() when ready.

function loadSheet(url, onLoad) {
    if (sheetCache[url]) {
        if (sheetCache[url].complete) onLoad(sheetCache[url]);
        else sheetCache[url].addEventListener('load', () => onLoad(sheetCache[url]));
        return;
    }
    const img = new Image();
    img.onload = () => { onLoad(img); render(); };
    img.src    = url;
    sheetCache[url] = img;
}

// ── HSL helpers ───────────────────────────────────────────────────

function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if      (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    return [h / 6, s, l];
}

function hslToRgb(h, s, l) {
    if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [h + 1/3, h, h - 1/3].map(t => {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1/6) return Math.round((p + (q - p) * 6 * t) * 255);
        if (t < 1/2) return Math.round(q * 255);
        if (t < 2/3) return Math.round((p + (q - p) * (2/3 - t) * 6) * 255);
        return Math.round(p * 255);
    });
}

// ── getSprite ─────────────────────────────────────────────────────
// Returns the tinted sprite for this player, or null if not ready.
// Builds it on first call; returns cached result thereafter.

function getSprite(p) {
    if (!p.sprite || !p.colour) return null;

    const { sheet, base, armour } = p.sprite;
    const [r, g, b] = p.colour;
    const key = `${sheet}|${base.x},${base.y}|${r},${g},${b}`;

    if (spriteCache[key]) return spriteCache[key];

    loadSheet(sheet, (img) => {
        if (spriteCache[key]) return;

        // Layer 1: base — drawn as-is
        const baseCanvas = new OffscreenCanvas(base.w, base.h);
        const bCtx       = baseCanvas.getContext('2d');
        bCtx.imageSmoothingEnabled = false;
        bCtx.drawImage(img, base.x, base.y, base.w, base.h, 0, 0, base.w, base.h);

        // Layer 2: armour — tinted with team colour
        const armourCanvas = new OffscreenCanvas(armour.w, armour.h);
        const aCtx         = armourCanvas.getContext('2d');
        aCtx.imageSmoothingEnabled = false;
        aCtx.drawImage(img, armour.x, armour.y, armour.w, armour.h, 0, 0, armour.w, armour.h);

        const imgData = aCtx.getImageData(0, 0, armour.w, armour.h);
        const d = imgData.data;
        // Recolour: keep each pixel's HSL lightness, replace hue+saturation
        // with the team colour's — shadows/highlights preserved, colour always vivid.
        const [th, ts] = rgbToHsl(r, g, b);
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 10) continue;
            const [,, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
            const [nr, ng, nb] = hslToRgb(th, ts, l);
            d[i] = nr; d[i + 1] = ng; d[i + 2] = nb;
        }
        aCtx.putImageData(imgData, 0, 0);

        // Composite: base layer, then armour on top
        // Use the larger of the two as the canvas size
        const W = Math.max(base.w, armour.w);
        const H = Math.max(base.h, armour.h);
        const final = new OffscreenCanvas(W, H);
        const fCtx  = final.getContext('2d');
        fCtx.imageSmoothingEnabled = false;
        fCtx.drawImage(baseCanvas,   0, 0);
        fCtx.drawImage(armourCanvas, 0, 0);

        spriteCache[key] = final;
    });

    return spriteCache[key] || null;
}

// ── loadSpriteSheet ───────────────────────────────────────────────
// Pre-warms the default sprite sheet so it's ready before the first render.

function loadSpriteSheet() {
    loadSheet('assets/sprites/human.gif', () => {
        console.log('Sprite sheet ready');
    });
}

// ── prewarmSprites ────────────────────────────────────────────────
// Pre-loads sprite sheets for a team definition so they're ready
// before the first render. Optional — getSprite loads lazily anyway.

function prewarmSprites(teamDef) {
    teamDef.players.forEach(p => {
        if (p.sprite) loadSheet(p.sprite.sheet, () => render());
    });
}

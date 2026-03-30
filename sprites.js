// sprites.js
// Builds tinted player sprites from the coordinates stored on each player object.
//
// Each player has:
//   p.sprite = { sheet, x, y, w, h }   — where to find them in the sprite sheet
//   p.colour = [r, g, b]               — team tint applied to the armour layer
//
// The sprite sheet layout (human.gif, 50×217):
//   Left  25px (x=0):  base layer — skin, outline — drawn as-is
//   Right 25px (x=25): armour layer — tinted with team colour
//
// Sprites are cached by a key derived from sheet + y + colour so they're
// only built once per unique combination.

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

// ── getSprite ─────────────────────────────────────────────────────
// Returns the tinted sprite for this player, or null if not ready.
// Builds it on first call; returns cached result thereafter.

function getSprite(p) {
    if (!p.sprite || !p.colour) return null;

    const { sheet, x, y, w, h } = p.sprite;
    const [r, g, b] = p.colour;
    const key = `${sheet}|${y}|${r},${g},${b}`;

    if (spriteCache[key]) return spriteCache[key];

    // Ensure the sheet is loaded
    loadSheet(sheet, (img) => {
        if (spriteCache[key]) return;  // already built by another call

        // Layer 1: base (left half) — drawn as-is
        const base  = new OffscreenCanvas(w, h);
        const bCtx  = base.getContext('2d');
        bCtx.imageSmoothingEnabled = false;
        bCtx.drawImage(img, x, y, w, h, 0, 0, w, h);

        // Layer 2: armour (right half) — tinted
        const armour = new OffscreenCanvas(w, h);
        const aCtx   = armour.getContext('2d');
        aCtx.imageSmoothingEnabled = false;
        aCtx.drawImage(img, x + w, y, w, h, -1, 0, w, h);  // -1 fixes 1px offset

        const imgData = aCtx.getImageData(0, 0, w, h);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 10) continue;
            d[i]     = Math.round(d[i]     * r / 255);
            d[i + 1] = Math.round(d[i + 1] * g / 255);
            d[i + 2] = Math.round(d[i + 2] * b / 255);
        }
        aCtx.putImageData(imgData, 0, 0);

        // Composite base + armour
        const final = new OffscreenCanvas(w, h);
        const fCtx  = final.getContext('2d');
        fCtx.imageSmoothingEnabled = false;
        fCtx.drawImage(base,   0, 0);
        fCtx.drawImage(armour, 0, 0);

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

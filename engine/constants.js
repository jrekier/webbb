// constants.js
// Shared values that never change during the game.
// Loaded first so every other file can use them.

// ── Ruleset configurations ────────────────────────────────────────
// Switch RULESET to change between game modes.
// Everything that depends on pitch size or turn count reads from here.

var RULESETS = {
    sevens: {
        name:       'Blood Bowl Sevens',
        COLS:       11,
        ROWS:       20,
        TURNS:      6,
        // SCR_HOME: top edge of home territory (row players stand on)
        // SCR_AWAY: bottom edge of away territory (row players stand on)
        END_ZONE_HOME:   19,
        END_ZONE_AWAY:   0,
        SCR_HOME:        13,   // home LoS drawn at top of this row
        SCR_AWAY:        6,    // away LoS drawn at bottom of this row
        WIDE_COLS:       [0, 1, 9, 10],
        PLAYERS_PER_TEAM: 7,
    },
    classic: {
        name:       'Blood Bowl',
        COLS:       15,
        ROWS:       26,
        TURNS:      8,
        END_ZONE_HOME:   [24, 25],
        END_ZONE_AWAY:   [0, 1],
        SCR_HOME:        13,
        SCR_AWAY:        12,
        WIDE_COLS:       [0, 1, 2, 12, 13, 14],
        PLAYERS_PER_TEAM: 11,
    },
};

// Active ruleset — change this to switch modes
var RULESET = RULESETS.sevens;

// Expose flat constants so the rest of the code
// can use COLS, ROWS etc. without knowing about rulesets
var COLS  = RULESET.COLS;
var ROWS  = RULESET.ROWS;
var TURNS = RULESET.TURNS;

// Cell size in pixels — updated by sizePitch() on resize
var CELL   = 32;

// Canvas and 2D drawing context — set up by buildPitch()
var canvas, ctx;

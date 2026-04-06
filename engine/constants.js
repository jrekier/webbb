// constants.js
// Shared values that never change during the game.
// Loaded first so every other file can use them.

const COLS  = 11;
const ROWS  = 20;
const TURNS = 6;

if (typeof module !== 'undefined') {
    module.exports = { COLS, ROWS, TURNS };
}

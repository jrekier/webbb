// state.js
// The entire game state lives in one object called G.
// Every other file reads from and writes to G.
// G is declared with var so all files share the same copy.

var G = {
    // Who is playing
    homeTeam: 'human',
    awayTeam: 'orc',

    // Whose turn it is — 'home' or 'away'
    active: 'home',
    turn: 1,
    half: 1,

    // Score
    homeScore: 0,
    awayScore: 0,

    // All players on the pitch — populated at game start
    players: [],

    // The ball
    ball: { col: 7, row: 13, carrier: null },

    // Selected player — for inspection only, always local
    sel: null,

    // The player currently taking their action (null if nobody activated)
    activated: null,

    // Block state — non-null while a block is being resolved.
    // Set by declareBlock(), cleared when block fully resolves.
    // {
    //   att:         the attacking player
    //   def:         the defending player
    //   rolls:       array of face objects rolled
    //   chooser:     'att' or 'def' — who picks the face
    //   phase:       'pick-face' | 'pick-push'
    //   chosenFace:  the face picked (set after pick-face)
    //   pushSquares: valid push destinations (set during pick-push)
    // }
    block: null,

    // Blitz state - non-null while a blitz is being resolved.
    // Set by declareBlitz(), cleared when blitz fully resolves.
    // {
    //   att:         the attacking player
    //   target:      the target player
    // }
    blitz: null,

    hasBlitzed: false, // Set to true after the active team blitzes, reset at turn end
};

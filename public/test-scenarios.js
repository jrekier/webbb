// test-scenarios.js
// Skill Lab scenario definitions. Each is a self-contained board state.
//
// Required fields:
//   name        — shown in the picker
//   description — shown below the picker
//   homeColour  — [r, g, b]
//   awayColour  — [r, g, b]
//   state       — partial G overrides (phase, active, receiver, kicker …)
//   players     — array of player objects; loadScenario fills in defaults
//   ball        — { col, row, carrierId? }
//   setup(G)    — optional hook called after G.players is built;
//                 use it to pre-set G.block, G.activated, etc. with live references

var SCENARIOS = [

    // ── Guard ─────────────────────────────────────────────────────────
    {
        name: 'Guard — assist through marking',
        description:
            'AWAY Attacker (ST3) blocks HOME Target (ST3). ' +
            'AWAY Guard is adjacent to the target but marked by HOME Marker. ' +
            'Without Guard the assist wouldn\'t count. ' +
            'Select the AWAY Attacker and right-click → Block to see +1 dice.',
        homeColour: [30, 100, 200],
        awayColour: [190, 50, 40],
        state: { phase: 'play', active: 'away', receiver: 'home', kicker: 'away' },
        players: [
            // home — target + marker
            { id: 0, side: 'home', name: 'Target',   pos: 'Lineman', ma: 6, st: 3, ag: 3, av: 8, skills: [],        col: 5, row: 9,  status: 'active' },
            { id: 1, side: 'home', name: 'Marker',   pos: 'Lineman', ma: 6, st: 3, ag: 3, av: 8, skills: [],        col: 6, row: 10, status: 'active' },
            // away — attacker + guard
            { id: 2, side: 'away', name: 'Attacker', pos: 'Blitzer', ma: 6, st: 3, ag: 3, av: 8, skills: [],        col: 4, row: 9,  status: 'active' },
            { id: 3, side: 'away', name: 'Guard',    pos: 'Guard',   ma: 6, st: 3, ag: 3, av: 8, skills: ['Guard'], col: 5, row: 10, status: 'active' },
        ],
        ball: { col: -1, row: -1 },
    },

    // ── Stand Firm ────────────────────────────────────────────────────
    {
        name: 'Stand Firm — PUSH result',
        description:
            'HOME Defender has Stand Firm. The block result is PUSH. ' +
            'Choose whether to use Stand Firm (stay in place) or accept the push.',
        homeColour: [30, 100, 200],
        awayColour: [190, 50, 40],
        state: { phase: 'play', active: 'away', receiver: 'home', kicker: 'away' },
        players: [
            { id: 0, side: 'home', name: 'Defender', pos: 'Blitzer', ma: 6, st: 3, ag: 3, av: 8, skills: ['Stand Firm'], col: 5, row: 9, status: 'active' },
            { id: 1, side: 'away', name: 'Attacker', pos: 'Blitzer', ma: 6, st: 3, ag: 3, av: 8, skills: [],             col: 4, row: 9, status: 'active' },
        ],
        ball: { col: -1, row: -1 },
        setup(G) {
            const att = G.players.find(p => p.id === 1);
            const def = G.players.find(p => p.id === 0);
            G.activated = att;
            G.block = {
                phase:          'stand-firm-choice',
                att,
                def,
                chosenFace:     { id: 'PUSH', label: 'Push', cls: '' },
                pushSquares:    [[6, 8], [6, 9], [6, 10]],
                pendingFollowUp: null,
                pushedPlayer:    null,
            };
        },
    },

    {
        name: 'Stand Firm — DEF_DOWN (falls in place)',
        description:
            'HOME Defender has Stand Firm. The block result is DEF_DOWN. ' +
            'Stand Firm prevents the push but NOT the knockdown — ' +
            'the defender still falls, just in their own square.',
        homeColour: [30, 100, 200],
        awayColour: [190, 50, 40],
        state: { phase: 'play', active: 'away', receiver: 'home', kicker: 'away' },
        players: [
            { id: 0, side: 'home', name: 'Defender', pos: 'Blitzer', ma: 6, st: 3, ag: 3, av: 8, skills: ['Stand Firm'], col: 5, row: 9, status: 'active' },
            { id: 1, side: 'away', name: 'Attacker', pos: 'Blitzer', ma: 6, st: 4, ag: 3, av: 9, skills: [],             col: 4, row: 9, status: 'active' },
        ],
        ball: { col: -1, row: -1 },
        setup(G) {
            const att = G.players.find(p => p.id === 1);
            const def = G.players.find(p => p.id === 0);
            G.activated = att;
            G.block = {
                phase:           'stand-firm-choice',
                att,
                def,
                chosenFace:      { id: 'DEF_DOWN', label: 'Defender\nDown', cls: 'good' },
                pushSquares:     [[6, 8], [6, 9], [6, 10]],
                pendingFollowUp: null,
                pushedPlayer:    null,
            };
        },
    },

    {
        name: 'Stand Firm — chain push stops dead',
        description:
            'HOME Blocker was pushed into HOME Stand Firm\'s square. ' +
            'If Stand Firm is used, neither player moves — the chain stops dead. ' +
            'Note: HOME Blocker sits on top of HOME Stand Firm (two tokens, same square).',
        homeColour: [30, 100, 200],
        awayColour: [190, 50, 40],
        state: { phase: 'play', active: 'away', receiver: 'home', kicker: 'away' },
        players: [
            // home_blocker will be at Stand Firm's square after the push
            { id: 0, side: 'home', name: 'Blocker',    pos: 'Lineman', ma: 6, st: 3, ag: 3, av: 8, skills: [],             col: 6, row: 9, status: 'active' },
            { id: 1, side: 'home', name: 'Stand Firm', pos: 'Blitzer', ma: 6, st: 3, ag: 3, av: 8, skills: ['Stand Firm'], col: 6, row: 9, status: 'active' },
            { id: 2, side: 'away', name: 'Attacker',   pos: 'Blitzer', ma: 6, st: 3, ag: 3, av: 8, skills: [],             col: 4, row: 9, status: 'active' },
        ],
        ball: { col: -1, row: -1 },
        setup(G) {
            const realAtt   = G.players.find(p => p.id === 2);
            const blocker   = G.players.find(p => p.id === 0);
            const standFirm = G.players.find(p => p.id === 1);
            G.activated = realAtt;
            // Simulate state after blocker was pushed from (5,9) into Stand Firm's square (6,9).
            // blocker is already placed at (6,9) in the players list.
            G.block = {
                phase:           'stand-firm-choice',
                att:             { col: 5, row: 9 },  // fakeAtt = blocker's vacated square
                def:             standFirm,
                chosenFace:      { id: 'PUSH', label: 'Push', cls: '' },
                pushSquares:     [[7, 8], [7, 9], [7, 10]],
                pendingFollowUp: { att: realAtt, vacCol: 5, vacRow: 9, ballDropped: false },
                pushedPlayer:    blocker,
            };
        },
    },

    {
        name: 'Stand Firm — prone chain victim (no offer)',
        description:
            'A prone player (HOME Prone) is in the push path of HOME Blocker. ' +
            'Prone players cannot use Stand Firm. ' +
            'Click the occupied square to push HOME Blocker through.',
        homeColour: [30, 100, 200],
        awayColour: [190, 50, 40],
        state: { phase: 'play', active: 'away', receiver: 'home', kicker: 'away' },
        players: [
            { id: 0, side: 'home', name: 'Blocker', pos: 'Lineman', ma: 6, st: 3, ag: 3, av: 8, skills: [],             col: 5, row: 9,  status: 'active' },
            { id: 1, side: 'home', name: 'Prone',   pos: 'Blitzer', ma: 6, st: 3, ag: 3, av: 8, skills: ['Stand Firm'], col: 6, row: 9,  status: 'prone'  },
            { id: 2, side: 'away', name: 'Attacker',pos: 'Blitzer', ma: 6, st: 3, ag: 3, av: 8, skills: [],             col: 4, row: 9,  status: 'active' },
        ],
        ball: { col: -1, row: -1 },
        setup(G) {
            const att     = G.players.find(p => p.id === 2);
            const blocker = G.players.find(p => p.id === 0);
            G.activated = att;
            // Block declared — waiting for push square selection.
            G.block = {
                phase:           'pick-push',
                att,
                def:             blocker,
                chosenFace:      { id: 'PUSH', label: 'Push', cls: '' },
                pushSquares:     [[6, 8], [6, 9], [6, 10]],
                pendingFollowUp: null,
                pushedPlayer:    null,
            };
        },
    },

    // ── Stunty ────────────────────────────────────────────────────────
    {
        name: 'Stunty — dodge ignores destination TZs',
        description:
            'AWAY Stunty player (AG3) is adjacent to HOME Marker and wants to dodge ' +
            'into a square covered by two HOME TZs. ' +
            'Without Stunty the target would be 5+ (AG3 + 2 TZs). ' +
            'With Stunty the destination TZs are ignored — target stays 3+. ' +
            'Select the AWAY Stunty player and move them to the highlighted square.',
        homeColour: [30, 100, 200],
        awayColour: [190, 50, 40],
        state: { phase: 'play', active: 'away', receiver: 'home', kicker: 'away' },
        players: [
            { id: 0, side: 'home', name: 'TZ1',    pos: 'Lineman', ma: 6, st: 3, ag: 3, av: 8, skills: [],        col: 6, row: 8,  status: 'active' },
            { id: 1, side: 'home', name: 'TZ2',    pos: 'Lineman', ma: 6, st: 3, ag: 3, av: 8, skills: [],        col: 6, row: 10, status: 'active' },
            { id: 2, side: 'home', name: 'Marker', pos: 'Lineman', ma: 6, st: 3, ag: 3, av: 8, skills: [],        col: 4, row: 9,  status: 'active' },
            { id: 3, side: 'away', name: 'Stunty', pos: 'Goblin',  ma: 6, st: 2, ag: 3, av: 7, skills: ['Stunty'], col: 5, row: 9,  status: 'active' },
        ],
        ball: { col: -1, row: -1 },
    },

    {
        name: 'Stunty — injury table (block it)',
        description:
            'HOME Attacker (ST4) blocks AWAY Stunty player (ST2, AV7). ' +
            'On injury the Stunty table applies: stunned ≤6, KO 7–8, casualty 9+. ' +
            'Select the HOME Attacker and right-click → Block to observe the injury log.',
        homeColour: [30, 100, 200],
        awayColour: [190, 50, 40],
        state: { phase: 'play', active: 'home', receiver: 'away', kicker: 'home' },
        players: [
            { id: 0, side: 'home', name: 'Attacker', pos: 'Blitzer', ma: 6, st: 4, ag: 3, av: 9, skills: [],        col: 4, row: 9, status: 'active' },
            { id: 1, side: 'away', name: 'Stunty',   pos: 'Goblin',  ma: 6, st: 2, ag: 3, av: 7, skills: ['Stunty'], col: 5, row: 9, status: 'active' },
        ],
        ball: { col: -1, row: -1 },
    },

    {
        name: 'Stunty — intercept penalty',
        description:
            'AWAY Stunty player (AG3) is in a position to intercept a HOME pass. ' +
            'Stunty adds +1 to the intercept target: accurate pass target is AG+3+1 = 7 (capped 6). ' +
            'Click "No Intercept" to skip, or select the interceptor in the pass UI.',
        homeColour: [30, 100, 200],
        awayColour: [190, 50, 40],
        state: { phase: 'play', active: 'home', receiver: 'away', kicker: 'home' },
        players: [
            { id: 0, side: 'home', name: 'Passer',    pos: 'Thrower',  ma: 6, st: 3, ag: 4, av: 8, skills: [],         col: 2, row: 9,  status: 'active' },
            { id: 1, side: 'home', name: 'Receiver',  pos: 'Catcher',  ma: 8, st: 2, ag: 4, av: 7, skills: [],         col: 8, row: 9,  status: 'active' },
            { id: 2, side: 'away', name: 'Stunty',    pos: 'Goblin',   ma: 6, st: 2, ag: 3, av: 7, skills: ['Stunty'], col: 5, row: 9,  status: 'active' },
        ],
        ball: { col: 2, row: 9, carrierId: 0 },
        setup(G) {
            const passer   = G.players.find(p => p.id === 0);
            const receiver = G.players.find(p => p.id === 1);
            const stunty   = G.players.find(p => p.id === 2);
            G.activated = passer;
            G.passing   = true;
            G.interceptionChoice = {
                declaredCol:    receiver.col,
                declaredRow:    receiver.row,
                actualCol:      receiver.col,
                actualRow:      receiver.row,
                accurate:       true,
                scatterMsg:     '',
                interceptorIds: [stunty.id],
            };
        },
    },

    // ── Bone Head ─────────────────────────────────────────────────────
    {
        name: 'Bone Head — activation roll',
        description:
            'AWAY Bone Head player (ST4) is about to be activated. ' +
            'When you Move, Block, or Blitz them, the engine rolls d6 first. ' +
            'On a 2+ they act normally; on a 1 they lose their action (and TZs). ' +
            'Block/Blitz also causes a TURNOVER on a 1. ' +
            'Reset to test repeatedly.',
        homeColour: [30, 100, 200],
        awayColour: [190, 50, 40],
        state: { phase: 'play', active: 'away', receiver: 'home', kicker: 'away' },
        players: [
            { id: 0, side: 'home', name: 'Target',    pos: 'Lineman', ma: 6, st: 3, ag: 3, av: 8, skills: [],           col: 6, row: 9, status: 'active' },
            { id: 1, side: 'away', name: 'Bone Head', pos: 'Ogre',    ma: 5, st: 5, ag: 2, av: 9, skills: ['Bone Head'], col: 5, row: 9, status: 'active' },
        ],
        ball: { col: -1, row: -1 },
    },

    {
        name: 'Bone Head — TZ lost, teammates free to move',
        description:
            'AWAY Bone Head player has already boned this turn (flag pre-set). ' +
            'HOME Lineman stands next to them: normally a TZ forces a dodge, ' +
            'but the boned Ogre has no TZ — click Move on HOME Lineman and step ' +
            'away freely (target shows 0, no dodge required).',
        homeColour: [30, 100, 200],
        awayColour: [190, 50, 40],
        state: { phase: 'play', active: 'home', receiver: 'away', kicker: 'home' },
        players: [
            { id: 0, side: 'home', name: 'Lineman',   pos: 'Lineman', ma: 6, st: 3, ag: 3, av: 8, skills: [],           col: 5, row: 9,  status: 'active' },
            { id: 1, side: 'away', name: 'Bone Head', pos: 'Ogre',    ma: 5, st: 5, ag: 2, av: 9, skills: ['Bone Head'], col: 6, row: 9,  status: 'active' },
        ],
        ball: { col: -1, row: -1 },
        setup(G) {
            const ogre = G.players.find(p => p.id === 1);
            ogre.bonedHead  = true;
            ogre.usedAction = true;
        },
    },
];

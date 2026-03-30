// teams.js
// Team loading and roster building.
// No DOM, no canvas, no rendering — works identically in browser and Node.js.

// ── loadTeamFromJSON ──────────────────────────────────────────────
// Validates and returns a team definition.

function loadTeamFromJSON(json) {
    if (!json.name)    throw 'Team must have a name';
    if (!json.colour)  throw 'Team must have a colour [r,g,b]';
    if (!json.players) throw 'Team must have a players array';
    json.players.forEach(p => {
        if (!p.pos)   throw `Player missing pos`;
        if (!p.ma)    throw `${p.pos} missing ma`;
        if (!p.st)    throw `${p.pos} missing st`;
        if (!p.count) throw `${p.pos} missing count`;
    });
    return json;
}

// ── buildRosterFromTeam ───────────────────────────────────────────
// Expands a team definition into individual player objects.

function buildRosterFromTeam(teamDef, side, startId, formation) {
    const players = [];
    let id  = startId;
    let pos = 0;

    teamDef.players.forEach(posData => {
        for (let i = 0; i < posData.count; i++) {
            const [col, row] = formation[pos] || [7, side === 'home' ? 20 : 5];
            players.push({
                id,
                side,
                pos:        posData.pos,
                ma:         posData.ma,
                st:         posData.st,
                ag:         posData.ag || 3,
                av:         posData.av,
                skills:     posData.skills || [],
                maLeft:     posData.ma,
                col,
                row,
                hasBall:    false,
                usedAction: false,
                status:     'active',
                sprite:     posData.sprite || null,
                colour:     teamDef.colour,
            });
            id++;
            pos++;
        }
    });

    return players;
}

// ── Node.js export ────────────────────────────────────────────────
if (typeof module !== 'undefined') {
    module.exports = { loadTeamFromJSON, buildRosterFromTeam };
}

// teams.js
// Team loading and roster building.
// No DOM, no canvas, no rendering — works identically in browser and Node.js.

// ── loadTeamFromJSON ──────────────────────────────────────────────
// Validates and returns a team definition.

function loadTeamFromJSON(json) {
    if (!json.name)    throw 'Team must have a name';
    if (!json.colour && !json.homeColour && !json.awayColour)
        throw 'Team must have a colour [r,g,b]';
    if (!json.players) throw 'Team must have a players array';
    json.players.forEach(p => {
        if (!p.name) throw `Player missing name`;
        if (!p.pos)  throw `${p.name} missing pos`;
        if (!p.ma)   throw `${p.name} missing ma`;
        if (!p.st)   throw `${p.name} missing st`;
    });
    return json;
}

// ── buildRosterFromTeam ───────────────────────────────────────────
// Builds individual player objects from a team definition.

function buildRosterFromTeam(teamDef, side, startId, formation) {
    return teamDef.players.map((p, i) => {
        const [col, row] = formation[i] || [-1, -1];  // beyond 7: start in reserve
        return {
            id:         startId + i,
            side,
            name:       p.name,
            pos:        p.pos,
            ma:         p.ma,
            st:         p.st,
            ag:         p.ag || 3,
            pa:         p.pa,
            av:         p.av,
            skills:     p.skills || [],
            maLeft:     p.ma,
            rushLeft:   2,
            col,
            row,
            hasBall:    false,
            usedAction: false,
            status:     'active',
            sprite:     p.sprite || null,
            colour:     teamDef.colour,
        };
    });
}

// ── Node.js export ────────────────────────────────────────────────
if (typeof module !== 'undefined') {
    module.exports = { loadTeamFromJSON, buildRosterFromTeam };
}

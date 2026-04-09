// roster-defs.js
// Canonical position definitions per race.
// Stats, costs, per-team limits, and sprite data for the team builder.
// Shared between browser (loaded as <script>) and server (require()).

const ROSTER_DEFS = {
    humans: {
        colour: [200, 30, 30],
        budget: 1000000,
        min: 7,
        max: 11,
        positions: [
            {
                pos: 'Lineman', ma: 6, st: 3, ag: 3, pa: 4, av: 8, skills: [],
                cost: 50000, limit: 12,
                sprite: { sheet: 'assets/sprites/human.gif',
                    base:   { x:  0, y: 162, w: 25, h: 27 },
                    armour: { x: 26, y: 162, w: 25, h: 27 } },
            },
            {
                pos: 'Blitzer', ma: 7, st: 3, ag: 3, pa: 4, av: 8, skills: ['Block'],
                cost: 90000, limit: 4,
                sprite: { sheet: 'assets/sprites/human.gif',
                    base:   { x:  0, y: 190, w: 25, h: 26 },
                    armour: { x: 26, y: 190, w: 25, h: 26 } },
            },
            {
                pos: 'Thrower', ma: 6, st: 3, ag: 3, pa: 2, av: 7, skills: ['Pass', 'Sure Hands'],
                cost: 80000, limit: 2,
                sprite: { sheet: 'assets/sprites/human.gif',
                    base:   { x:  0, y: 108, w: 25, h: 26 },
                    armour: { x: 26, y: 108, w: 25, h: 26 } },
            },
            {
                pos: 'Catcher', ma: 8, st: 2, ag: 3, pa: 5, av: 7, skills: ['Dodge', 'Catch'],
                cost: 75000, limit: 4,
                sprite: { sheet: 'assets/sprites/human.gif',
                    base:   { x:  0, y:  27, w: 25, h: 26 },
                    armour: { x: 26, y:  27, w: 25, h: 26 } },
            },
        ],
    },

    orcs: {
        colour: [30, 80, 180],
        budget: 1000000,
        min: 7,
        max: 11,
        positions: [
            {
                pos: 'Lineman', ma: 5, st: 3, ag: 3, pa: 4, av: 9, skills: [],
                cost: 50000, limit: 12,
                sprite: { sheet: 'assets/sprites/orc.gif',
                    base:   { x:  0, y:  0, w: 26, h: 26 },
                    armour: { x: 32, y:  0, w: 26, h: 26 } },
            },
            {
                pos: 'Blitzer', ma: 6, st: 3, ag: 3, pa: 4, av: 9, skills: ['Block'],
                cost: 80000, limit: 4,
                sprite: { sheet: 'assets/sprites/orc.gif',
                    base:   { x:  0, y: 83, w: 27, h: 25 },
                    armour: { x: 32, y: 82, w: 27, h: 26 } },
            },
            {
                pos: 'Thrower', ma: 5, st: 3, ag: 3, pa: 3, av: 9, skills: ['Pass', 'Sure Hands'],
                cost: 70000, limit: 2,
                sprite: { sheet: 'assets/sprites/orc.gif',
                    base:   { x:  0, y:  0, w: 26, h: 26 },
                    armour: { x: 32, y:  0, w: 26, h: 26 } },
            },
            {
                pos: 'Black Orc', ma: 4, st: 4, ag: 2, pa: 6, av: 9, skills: [],
                cost: 90000, limit: 4,
                sprite: { sheet: 'assets/sprites/orc.gif',
                    base:   { x:  0, y: 191, w: 30, h: 31 },
                    armour: { x: 32, y: 191, w: 29, h: 31 } },
            },
        ],
    },
};

// ── expandTeam ────────────────────────────────────────────────────
// Convert a DB team {name, race, roster:[{pos,name}]} to a full team
// definition compatible with buildRosterFromTeam().

function expandTeam(dbTeam) {
    const raceDef = ROSTER_DEFS[dbTeam.race];
    if (!raceDef) return null;
    const players = dbTeam.roster.map(slot => {
        const posDef = raceDef.positions.find(p => p.pos === slot.pos);
        if (!posDef) return null;
        return {
            name:   slot.name,
            pos:    posDef.pos,
            ma:     posDef.ma,
            st:     posDef.st,
            ag:     posDef.ag,
            pa:     posDef.pa,
            av:     posDef.av,
            skills: [...posDef.skills],
            sprite: posDef.sprite,
        };
    }).filter(Boolean);
    return { name: dbTeam.name, colour: raceDef.colour, players };
}

// ── rosterCost ────────────────────────────────────────────────────
// Total cost of a roster array [{pos, name}] for a given race.

function rosterCost(race, roster) {
    const raceDef = ROSTER_DEFS[race];
    if (!raceDef) return 0;
    return roster.reduce((sum, slot) => {
        const pd = raceDef.positions.find(p => p.pos === slot.pos);
        return sum + (pd ? pd.cost : 0);
    }, 0);
}

if (typeof module !== 'undefined') {
    module.exports = { ROSTER_DEFS, expandTeam, rosterCost };
}

// auth.js
// Client-side authentication, team management, and team builder.

// ── Auth state ────────────────────────────────────────────────────

const AUTH_TOKEN_KEY   = 'bbAuthToken';
const ACTIVE_TEAM_KEY  = 'bbActiveTeamId';
let _currentUser = null;

function getCurrentUser()    { return _currentUser; }
function getAuthToken()      { return localStorage.getItem(AUTH_TOKEN_KEY); }
function getActiveTeamId()   { const v = localStorage.getItem(ACTIVE_TEAM_KEY); return v ? parseInt(v) : null; }
function _setAuthToken(t)    { localStorage.setItem(AUTH_TOKEN_KEY, t); }
function _clearAuthToken()   { localStorage.removeItem(AUTH_TOKEN_KEY); }
function _setActiveTeam(id)  { if (id) localStorage.setItem(ACTIVE_TEAM_KEY, id); else localStorage.removeItem(ACTIVE_TEAM_KEY); }

// ── API helpers ───────────────────────────────────────────────────

function _authHeaders() {
    return { 'Authorization': 'Bearer ' + getAuthToken() };
}

async function _post(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ..._authHeaders() },
        body: JSON.stringify(body),
    });
    return res.json();
}

async function _put(url, body) {
    const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ..._authHeaders() },
        body: JSON.stringify(body),
    });
    return res.json();
}

async function _get(url) {
    const res = await fetch(url, { headers: _authHeaders() });
    return res.json();
}

async function _del(url) {
    const res = await fetch(url, { method: 'DELETE', headers: _authHeaders() });
    return res.json();
}

// ── Session ───────────────────────────────────────────────────────

async function checkAuth() {
    if (!getAuthToken()) return null;
    try {
        const data = await _get('/api/me');
        if (data.error) { _clearAuthToken(); return null; }
        _currentUser = data.user;
        return _currentUser;
    } catch {
        return null;
    }
}

// ── Auth screen ───────────────────────────────────────────────────

function showAuthTab(tab) {
    document.getElementById('auth-tab-login').classList.toggle('auth-tab--active', tab === 'login');
    document.getElementById('auth-tab-register').classList.toggle('auth-tab--active', tab === 'register');
    document.getElementById('auth-form-login').classList.toggle('hidden', tab !== 'login');
    document.getElementById('auth-form-register').classList.toggle('hidden', tab !== 'register');
    document.getElementById('auth-error').textContent = '';
}

function _showAuthError(msg) {
    document.getElementById('auth-error').textContent = msg;
}

async function onAuthLogin() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    if (!username || !password) return _showAuthError('Please fill in all fields.');
    const data = await _post('/api/login', { username, password });
    if (data.error) return _showAuthError(data.error);
    _setAuthToken(data.token);
    _currentUser = data.user;
    _onAuthSuccess();
}

async function onAuthRegister() {
    const username = document.getElementById('register-username').value.trim();
    const password = document.getElementById('register-password').value;
    const confirm  = document.getElementById('register-confirm').value;
    if (!username || !password || !confirm) return _showAuthError('Please fill in all fields.');
    if (password !== confirm) return _showAuthError('Passwords do not match.');
    const data = await _post('/api/register', { username, password });
    if (data.error) return _showAuthError(data.error);
    _setAuthToken(data.token);
    _currentUser = data.user;
    _onAuthSuccess();
}

function _onAuthSuccess() {
    document.getElementById('welcome-username').textContent = _currentUser.username;
    showScreen('welcome');
}

async function onClickLogout() {
    await _post('/api/logout', {});
    _clearAuthToken();
    _setActiveTeam(null);
    _currentUser = null;
    showScreen('auth');
}

// ── Teams list screen ─────────────────────────────────────────────

async function onClickMyTeams() {
    showScreen('teams');
    await _loadTeamsList();
}

async function _loadTeamsList() {
    const data = await _get('/api/teams');
    const list = document.getElementById('teams-list');
    list.innerHTML = '';
    if (!data.teams || data.teams.length === 0) {
        list.innerHTML = '<div class="teams-empty">No teams yet. Create one below.</div>';
        _updateActiveTeamLabel(null);
        return;
    }
    const activeId = getActiveTeamId();
    data.teams.forEach(team => {
        const isActive = team.id === activeId;
        const row = document.createElement('div');
        row.className = 'team-row' + (isActive ? ' team-row--active' : '');
        row.innerHTML = `
            <span class="team-row-active-dot" title="Active team">▶</span>
            <span class="team-row-name">${_esc(team.name)}</span>
            <span class="team-row-race">${team.race}</span>
            <span class="team-row-count">${team.roster.length}p</span>
            <button class="team-row-edit"   onclick="openTeamBuilder(${team.id})">Edit</button>
            <button class="team-row-delete" onclick="onDeleteTeam(${team.id})">✕</button>
        `;
        row.addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            _setActiveTeam(team.id);
            _loadTeamsList();
            _updateWelcomeActiveTeam(team);
        });
        list.appendChild(row);
    });
    _updateActiveTeamLabel(data.teams.find(t => t.id === activeId) || null);
}

function _updateActiveTeamLabel(team) {
    const el = document.getElementById('welcome-active-team');
    if (!el) return;
    el.textContent = team ? team.name + ' (' + team.race + ')' : 'Default roster';
}

function _updateWelcomeActiveTeam(team) {
    const el = document.getElementById('welcome-active-team');
    if (el) el.textContent = team ? team.name + ' (' + team.race + ')' : 'Default roster';
}

async function onDeleteTeam(id) {
    if (getActiveTeamId() === id) _setActiveTeam(null);
    await _del('/api/teams/' + id);
    _loadTeamsList();
}

// ── Team builder ──────────────────────────────────────────────────
// _builder holds all mutable state while editing.

let _builder = null;

async function openTeamBuilder(teamId) {
    if (teamId) {
        // Load existing team for editing
        const data = await _get('/api/teams');
        const team = data.teams && data.teams.find(t => t.id === teamId);
        if (!team) return;
        _builder = {
            id:     team.id,
            name:   team.name,
            race:   team.race,
            roster: team.roster.map(p => ({ ...p })),
            locked: true, // race is locked on existing teams
        };
    } else {
        _builder = { id: null, name: '', race: 'humans', roster: [], locked: false };
    }
    _renderBuilder();
    showScreen('team-builder');
}

function _renderBuilder() {
    const { name, race, roster, locked } = _builder;
    const raceDef  = ROSTER_DEFS[race];
    const budget   = raceDef.budget;
    const spent    = rosterCost(race, roster);
    const remaining = budget - spent;

    document.getElementById('builder-team-name').value = name;

    const raceEl = document.getElementById('builder-race');
    raceEl.value = race;
    raceEl.disabled = locked;

    // Budget
    document.getElementById('builder-budget-spent').textContent    = _fmt(spent);
    document.getElementById('builder-budget-remaining').textContent = _fmt(remaining);
    const pct = Math.min(100, (spent / budget) * 100);
    document.getElementById('builder-budget-fill').style.width = pct + '%';
    document.getElementById('builder-budget-fill').style.background =
        pct > 100 ? 'var(--home)' : 'var(--text-dim)';

    // Player count
    document.getElementById('builder-player-count').textContent =
        `${roster.length} / ${raceDef.min}–${raceDef.max}`;

    // Roster list
    const rosterEl = document.getElementById('builder-roster-list');
    rosterEl.innerHTML = '';
    roster.forEach((slot, i) => {
        const pd = raceDef.positions.find(p => p.pos === slot.pos);
        const row = document.createElement('div');
        row.className = 'builder-player-row';
        row.innerHTML = `
            <span class="builder-player-pos">${slot.pos}</span>
            <input class="builder-player-name" type="text" value="${_esc(slot.name)}"
                   maxlength="24" placeholder="Player name"
                   oninput="onBuilderNameChange(${i}, this.value)">
            <span class="builder-player-cost">${_fmt(pd ? pd.cost : 0)}</span>
            <button class="builder-player-remove" onclick="onBuilderRemove(${i})">✕</button>
        `;
        rosterEl.appendChild(row);
    });
    if (roster.length === 0) {
        rosterEl.innerHTML = '<div class="teams-empty">No players yet.</div>';
    }

    // Available positions
    const posGrid = document.getElementById('builder-positions-grid');
    posGrid.innerHTML = '';
    raceDef.positions.forEach(pd => {
        const count    = roster.filter(p => p.pos === pd.pos).length;
        const canAdd   = count < pd.limit && remaining >= pd.cost && roster.length < raceDef.max;
        const card     = document.createElement('div');
        card.className = 'pos-card' + (canAdd ? '' : ' pos-card--disabled');
        card.innerHTML = `
            <div class="pos-card-name">${pd.pos}</div>
            <div class="pos-card-stats">MA${pd.ma} ST${pd.st} AG${pd.ag} AV${pd.av}</div>
            <div class="pos-card-skills">${pd.skills.length ? pd.skills.join(', ') : '–'}</div>
            <div class="pos-card-footer">
                <span class="pos-card-cost">${_fmt(pd.cost)}</span>
                <span class="pos-card-slots">${count}/${pd.limit}</span>
            </div>
        `;
        if (canAdd) card.addEventListener('click', () => onBuilderAdd(pd.pos));
        posGrid.appendChild(card);
    });

    // Save button state
    const valid = roster.length >= raceDef.min && roster.length <= raceDef.max && remaining >= 0;
    document.getElementById('builder-save-btn').disabled = !valid;
    document.getElementById('builder-error').textContent = '';
}

function onBuilderRaceChange() {
    if (_builder.locked) return;
    _builder.race   = document.getElementById('builder-race').value;
    _builder.roster = [];
    _renderBuilder();
}

function onBuilderNameChange(index, value) {
    if (_builder.roster[index]) _builder.roster[index].name = value;
}

function onBuilderAdd(pos) {
    const defaultName = pos + ' ' + (_builder.roster.filter(p => p.pos === pos).length + 1);
    _builder.roster.push({ pos, name: defaultName });
    _renderBuilder();
    // Focus the new player's name input
    const inputs = document.querySelectorAll('.builder-player-name');
    if (inputs.length) inputs[inputs.length - 1].focus();
}

function onBuilderRemove(index) {
    _builder.roster.splice(index, 1);
    _renderBuilder();
}

async function onSaveTeam() {
    // Sync any name inputs that may not have fired oninput
    document.querySelectorAll('.builder-player-name').forEach((input, i) => {
        if (_builder.roster[i]) _builder.roster[i].name = input.value.trim() || _builder.roster[i].name;
    });

    const name   = document.getElementById('builder-team-name').value.trim();
    const roster = _builder.roster;
    if (!name) {
        document.getElementById('builder-error').textContent = 'Give your team a name.';
        return;
    }

    let result;
    if (_builder.id) {
        result = await _put('/api/teams/' + _builder.id, { name, roster });
    } else {
        result = await _post('/api/teams', { name, race: _builder.race, roster });
        if (!result.error) _setActiveTeam(result.team.id);
    }

    if (result.error) {
        document.getElementById('builder-error').textContent = result.error;
        return;
    }

    _builder = null;
    showScreen('teams');
    await _loadTeamsList();
}

// ── Util ──────────────────────────────────────────────────────────

function _esc(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _fmt(n) {
    return (n / 1000).toFixed(0) + 'k';
}

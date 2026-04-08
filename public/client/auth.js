// auth.js
// Client-side authentication and team management.
// Exposes: checkAuth(), getCurrentUser(), and all onclick handlers for auth/teams screens.

// ── State ─────────────────────────────────────────────────────────

const AUTH_TOKEN_KEY = 'bbAuthToken';
let _currentUser = null;

function getCurrentUser()  { return _currentUser; }
function getAuthToken()    { return localStorage.getItem(AUTH_TOKEN_KEY); }
function _setAuthToken(t)  { localStorage.setItem(AUTH_TOKEN_KEY, t); }
function _clearAuthToken() { localStorage.removeItem(AUTH_TOKEN_KEY); }

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

async function _get(url) {
    const res = await fetch(url, { headers: _authHeaders() });
    return res.json();
}

async function _del(url) {
    const res = await fetch(url, { method: 'DELETE', headers: _authHeaders() });
    return res.json();
}

// ── Session check ─────────────────────────────────────────────────

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
    _currentUser = null;
    showScreen('auth');
}

// ── Teams screen ──────────────────────────────────────────────────

async function onClickMyTeams() {
    showScreen('teams');
    _loadTeamsList();
}

async function _loadTeamsList() {
    const data = await _get('/api/teams');
    const list = document.getElementById('teams-list');
    list.innerHTML = '';
    if (!data.teams || data.teams.length === 0) {
        list.innerHTML = '<div class="teams-empty">No teams yet.</div>';
        return;
    }
    data.teams.forEach(team => {
        const row = document.createElement('div');
        row.className = 'team-row';
        row.innerHTML = `
            <span class="team-row-name">${_esc(team.name)}</span>
            <span class="team-row-race">${team.race}</span>
            <button class="team-row-delete" onclick="onDeleteTeam(${team.id})">✕</button>
        `;
        list.appendChild(row);
    });
}

async function onCreateTeam() {
    const name = document.getElementById('new-team-name').value.trim();
    const race = document.getElementById('new-team-race').value;
    if (!name) return;
    const data = await _post('/api/teams', { name, race });
    if (data.error) { document.getElementById('teams-create-error').textContent = data.error; return; }
    document.getElementById('new-team-name').value = '';
    document.getElementById('teams-create-error').textContent = '';
    _loadTeamsList();
}

async function onDeleteTeam(id) {
    await _del('/api/teams/' + id);
    _loadTeamsList();
}

// ── Util ──────────────────────────────────────────────────────────

function _esc(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

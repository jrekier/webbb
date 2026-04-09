'use strict';

const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');

// ── Setup ─────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const db = new Database(path.join(DATA_DIR, 'bb.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT UNIQUE NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS teams (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    race       TEXT NOT NULL,
    roster     TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER DEFAULT (unixepoch())
  );
`);

// Migrate existing databases that predate the roster column
try { db.exec('ALTER TABLE teams ADD COLUMN roster TEXT NOT NULL DEFAULT \'[]\''); } catch {}

// ── Prepared statements ───────────────────────────────────────────

const q = {
    userByName:     db.prepare('SELECT * FROM users WHERE username = ?'),
    userById:       db.prepare('SELECT id, username FROM users WHERE id = ?'),
    insertUser:     db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)'),
    insertSession:  db.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)'),
    sessionByToken: db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > unixepoch()'),
    deleteSession:  db.prepare('DELETE FROM sessions WHERE token = ?'),
    pruneExpired:   db.prepare('DELETE FROM sessions WHERE expires_at <= unixepoch()'),
    teamsByUser:    db.prepare('SELECT id, name, race, roster, created_at FROM teams WHERE user_id = ? ORDER BY created_at DESC'),
    teamById:       db.prepare('SELECT id, name, race, roster FROM teams WHERE id = ? AND user_id = ?'),
    insertTeam:     db.prepare('INSERT INTO teams (user_id, name, race, roster) VALUES (?, ?, ?, ?)'),
    updateTeam:     db.prepare('UPDATE teams SET name = ?, roster = ? WHERE id = ? AND user_id = ?'),
    deleteTeam:     db.prepare('DELETE FROM teams WHERE id = ? AND user_id = ?'),
};

const VALID_RACES = new Set(['humans', 'orcs']);

// ── Auth ──────────────────────────────────────────────────────────

function register(username, password) {
    if (!username || username.length < 3 || username.length > 20)
        return { error: 'Username must be 3–20 characters' };
    if (!/^[a-zA-Z0-9_]+$/.test(username))
        return { error: 'Username may only contain letters, digits, and underscores' };
    if (!password || password.length < 6)
        return { error: 'Password must be at least 6 characters' };
    if (q.userByName.get(username))
        return { error: 'Username already taken' };
    const hash = bcrypt.hashSync(password, 10);
    const { lastInsertRowid: id } = q.insertUser.run(username, hash);
    return { token: _newSession(id), user: { id, username } };
}

function login(username, password) {
    const row = q.userByName.get(username);
    if (!row || !bcrypt.compareSync(password, row.password_hash))
        return { error: 'Invalid username or password' };
    return { token: _newSession(row.id), user: { id: row.id, username: row.username } };
}

function logout(token) {
    if (token) q.deleteSession.run(token);
}

function validateSession(token) {
    if (!token) return null;
    const session = q.sessionByToken.get(token);
    if (!session) return null;
    return q.userById.get(session.user_id);
}

// ── Teams ─────────────────────────────────────────────────────────

function getTeams(userId) {
    return q.teamsByUser.all(userId).map(_parseRoster);
}

function getTeam(userId, teamId) {
    const row = q.teamById.get(teamId, userId);
    return row ? _parseRoster(row) : null;
}

function createTeam(userId, name, race, roster = []) {
    name = (name || '').trim();
    if (!name || name.length > 40)  return { error: 'Team name must be 1–40 characters' };
    if (!VALID_RACES.has(race))     return { error: 'Invalid race' };
    if (!Array.isArray(roster))     return { error: 'Invalid roster' };
    const rosterJson = JSON.stringify(roster);
    const { lastInsertRowid: id } = q.insertTeam.run(userId, name, race, rosterJson);
    return { team: { id, name, race, roster } };
}

function updateTeam(userId, teamId, name, roster) {
    name = (name || '').trim();
    if (!name || name.length > 40) return { error: 'Team name must be 1–40 characters' };
    if (!Array.isArray(roster))    return { error: 'Invalid roster' };
    const { changes } = q.updateTeam.run(name, JSON.stringify(roster), teamId, userId);
    return changes ? { ok: true } : { error: 'Team not found' };
}

function deleteTeam(userId, teamId) {
    const { changes } = q.deleteTeam.run(teamId, userId);
    return changes ? { ok: true } : { error: 'Team not found' };
}

// ── Internals ─────────────────────────────────────────────────────

function _newSession(userId) {
    q.pruneExpired.run();
    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 3600; // 30 days
    q.insertSession.run(userId, token, expiresAt);
    return token;
}

function _parseRoster(row) {
    try { return { ...row, roster: JSON.parse(row.roster || '[]') }; }
    catch { return { ...row, roster: [] }; }
}

module.exports = { register, login, logout, validateSession, getTeams, getTeam, createTeam, updateTeam, deleteTeam };

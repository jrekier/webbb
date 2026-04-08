// lobby.js
// Lobby screen — shows open rooms and lets the player create or join one.

function enterLobby() {
    showScreen('lobby');
    sendAction({ type: 'ENTER_LOBBY' });
}

// ── onLobbyUpdate ─────────────────────────────────────────────────
// Called by network.js when the server broadcasts a room list update.

function onLobbyUpdate(roomList) {
    const waiting = roomList.filter(r => r.status === 'waiting');
    const playing = roomList.filter(r => r.status === 'playing');

    _renderWaiting(waiting);
    _renderPlaying(playing);
}

function _renderWaiting(rooms) {
    const list = document.getElementById('lobby-waiting-list');
    list.innerHTML = '';

    if (rooms.length === 0) {
        list.innerHTML = '<div class="lobby-empty">No open games yet.</div>';
        return;
    }

    rooms.forEach(room => {
        const card = document.createElement('div');
        card.className = 'lobby-card lobby-card--open';
        card.innerHTML = `
            <span class="lobby-card-label">Waiting for opponent</span>
            <span class="lobby-card-action">Join →</span>
        `;
        card.addEventListener('click', () => sendAction({ type: 'JOIN_ROOM', roomId: room.id }));
        list.appendChild(card);
    });
}

function _renderPlaying(rooms) {
    const list = document.getElementById('lobby-playing-list');
    list.innerHTML = '';

    if (rooms.length === 0) {
        list.innerHTML = '<div class="lobby-empty">No games in progress.</div>';
        return;
    }

    rooms.forEach(() => {
        const card = document.createElement('div');
        card.className = 'lobby-card lobby-card--playing';
        card.innerHTML = `
            <span class="lobby-card-label">Game in progress</span>
            <span class="lobby-card-status">●</span>
        `;
        list.appendChild(card);
    });
}

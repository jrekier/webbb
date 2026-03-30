// lobby.js
// Lobby screen — shows open rooms and lets the player create or join one.

function enterLobby() {
    showScreen('lobby');
    sendAction({ type: 'ENTER_LOBBY' });
}

// ── onLobbyUpdate ─────────────────────────────────────────────────
// Called by network.js when the server broadcasts a room list update.

function onLobbyUpdate(roomList) {
    const list    = document.getElementById('lobby-room-list');
    const waiting = roomList.filter(r => r.status === 'waiting');

    list.innerHTML = '';

    if (waiting.length === 0) {
        list.innerHTML = '<div class="lobby-empty">No open games. Create one!</div>';
        return;
    }

    waiting.forEach(room => {
        const row = document.createElement('div');
        row.className = 'lobby-room-row';
        row.textContent = 'Open game';
        row.addEventListener('click', () => sendAction({ type: 'JOIN_ROOM', roomId: room.id }));
        list.appendChild(row);
    });
}

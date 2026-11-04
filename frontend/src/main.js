import './style.css';
import {
  ensureAnonymousSession,
  createRoom,
  joinRoom,
  fetchRoom,
  toggleReady,
  leaveRoom,
  subscribeToRoom,
} from './supabase.js';

// Application State
let currentUser = null;
let currentRoom = null;
let currentPlayers = [];
let unsubscribeRealtime = null;

// DOM Elements - Alerts
const alertBox = document.getElementById('alert-box');
const alertMsg = document.getElementById('alert-msg');
const alertClose = document.getElementById('alert-close');

// DOM Elements - Views
const landingView = document.getElementById('landing-view');
const lobbyView = document.getElementById('lobby-view');

// DOM Elements - Landing Cards & Modal
const hostCard = document.getElementById('host-card');
const joinCard = document.getElementById('join-card');
const btnOpenHostPrompt = document.getElementById('btn-open-host-prompt');

const hostModal = document.getElementById('host-modal');
const hostPlayerName = document.getElementById('host-player-name');
const btnCancelHost = document.getElementById('btn-cancel-host');
const btnConfirmCreateRoom = document.getElementById('btn-confirm-create-room');

const joinPlayerName = document.getElementById('join-player-name');
const btnJoinGame = document.getElementById('btn-join-game');

// DOM Elements - Lobby
const roomBanner = document.getElementById('room-banner');
const lobbyRoomId = document.getElementById('lobby-room-id');
const btnCopyLink = document.getElementById('btn-copy-link');
const playerCountEl = document.getElementById('player-count');
const seatsGrid = document.getElementById('seats-grid');

const lobbyWaitMsg = document.getElementById('lobby-wait-msg');
const btnStartGame = document.getElementById('btn-start-game');
const btnLeaveRoom = document.getElementById('btn-leave-room');

// Helpers
function showAlert(message, type = 'error') {
  alertMsg.textContent = message;
  alertBox.className = `alert alert-${type}`;
  alertBox.classList.remove('hidden');
}

function hideAlert() {
  alertBox.classList.add('hidden');
}

alertClose.addEventListener('click', hideAlert);

function getSavedName() {
  return localStorage.getItem('houseflippah_player_name') || '';
}

function saveName(name) {
  localStorage.setItem('houseflippah_player_name', name.trim());
}

function getQueryParam(key) {
  const params = new URLSearchParams(window.location.search);
  return params.get(key);
}

function setRoomUrl(roomId) {
  const url = new URL(window.location.href);
  if (roomId) {
    url.searchParams.set('room', roomId);
  } else {
    url.searchParams.delete('room');
  }
  window.history.pushState({}, '', url);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Render Seats UI (1 to 4)
function renderSeats() {
  seatsGrid.innerHTML = '';
  const myPlayer = currentPlayers.find((p) => p.user_id === currentUser.id);

  playerCountEl.textContent = currentPlayers.length;

  for (let seatNum = 1; seatNum <= 4; seatNum++) {
    const player = currentPlayers.find((p) => p.seat_number === seatNum);
    const seatEl = document.createElement('div');
    seatEl.className = 'seat-card';

    if (player) {
      seatEl.classList.add('occupied');
      const isYou = player.user_id === currentUser.id;
      if (isYou) seatEl.classList.add('is-you');

      seatEl.innerHTML = `
        <div class="seat-header">
          <span>Seat ${seatNum}</span>
          <div style="display: flex; gap: 0.25rem;">
            ${player.is_host ? '<span class="badge badge-host">Host</span>' : ''}
            ${isYou ? '<span class="badge badge-you">You</span>' : ''}
          </div>
        </div>
        <div class="seat-name">${escapeHtml(player.display_name)}</div>
        <div class="status-indicator status-ready">
          ● Connected
        </div>
      `;
    } else {
      seatEl.innerHTML = `
        <div class="seat-header">
          <span>Seat ${seatNum}</span>
        </div>
        <div class="seat-empty-text">Empty Slot</div>
        <div style="font-size: 0.8rem; color: var(--text-muted);">Available</div>
      `;
    }

    seatsGrid.appendChild(seatEl);
  }

  // Update button states and host-only elements
  if (myPlayer) {
    if (myPlayer.is_host) {
      roomBanner.classList.remove('hidden');
      btnLeaveRoom.classList.remove('hidden');
      btnStartGame.classList.remove('hidden');
      if (lobbyWaitMsg) lobbyWaitMsg.classList.add('hidden');
      const canStart = currentPlayers.length >= 2;
      btnStartGame.disabled = !canStart;
      btnStartGame.title = canStart
        ? 'Start Game'
        : 'Waiting for players to join (2-4 players needed)';
    } else {
      roomBanner.classList.add('hidden');
      btnLeaveRoom.classList.add('hidden');
      btnStartGame.classList.add('hidden');
      if (lobbyWaitMsg) lobbyWaitMsg.classList.remove('hidden');
    }
  }
}

// Switch to Lobby View
function showLobbyView(room, players) {
  currentRoom = room;
  currentPlayers = players;

  document.getElementById('app').classList.add('in-lobby');
  landingView.classList.add('hidden');
  lobbyView.classList.remove('hidden');

  lobbyRoomId.textContent = room.id;
  setRoomUrl(room.id);

  renderSeats();

  // Clean up any existing realtime channel before opening a new one
  if (unsubscribeRealtime) unsubscribeRealtime();

  unsubscribeRealtime = subscribeToRoom(
    room.id,
    async () => {
      try {
        const { players: updatedPlayers } = await fetchRoom(room.id);
        currentPlayers = updatedPlayers;
        renderSeats();
      } catch (err) {
        console.error('Error refreshing players:', err);
      }
    },
    (roomChange) => {
      if (roomChange.new) {
        currentRoom = roomChange.new;
        if (currentRoom.status === 'in_progress') {
          showAlert('Game has started!', 'info');
        } else if (currentRoom.status === 'abandoned') {
          showAlert('The host has ended the game.', 'info');
          showLandingView();
        }
      }
    }
  );
}

// Switch to Landing View
function showLandingView() {
  if (unsubscribeRealtime) {
    unsubscribeRealtime();
    unsubscribeRealtime = null;
  }
  currentRoom = null;
  currentPlayers = [];
  setRoomUrl(null);

  document.getElementById('app').classList.remove('in-lobby');
  lobbyView.classList.add('hidden');
  landingView.classList.remove('hidden');

  // Default to showing only host card
  hostCard.classList.remove('hidden');
  joinCard.classList.add('hidden');
}

// --- Host Creation Flow ---
function openHostModal() {
  hostPlayerName.value = getSavedName();
  hostModal.classList.remove('hidden');
  setTimeout(() => hostPlayerName.focus(), 50);
}

function closeHostModal() {
  hostModal.classList.add('hidden');
}

async function handleConfirmCreateRoom() {
  const name = hostPlayerName.value.trim();
  if (!name) {
    showAlert('Please enter your username.');
    hostPlayerName.focus();
    return;
  }

  saveName(name);
  hideAlert();
  btnConfirmCreateRoom.disabled = true;

  try {
    const result = await createRoom(name);
    closeHostModal();
    const { room, player } = result;
    showLobbyView(room, [player]);
  } catch (err) {
    showAlert(err.message || 'Failed to create room.');
  } finally {
    btnConfirmCreateRoom.disabled = false;
  }
}

btnOpenHostPrompt.addEventListener('click', openHostModal);
btnCancelHost.addEventListener('click', closeHostModal);
btnConfirmCreateRoom.addEventListener('click', handleConfirmCreateRoom);

hostPlayerName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleConfirmCreateRoom();
  if (e.key === 'Escape') closeHostModal();
});

// Close modal if clicking outside card
hostModal.addEventListener('click', (e) => {
  if (e.target === hostModal) closeHostModal();
});

// --- Join Room Flow (via Invite Link) ---
async function handleJoinRoom() {
  const inviteRoomId = getQueryParam('room');
  const name = joinPlayerName.value.trim();

  if (!name) {
    showAlert('Please enter your username.');
    joinPlayerName.focus();
    return;
  }
  if (!inviteRoomId) {
    showAlert('No game room found in URL.');
    return;
  }

  saveName(name);
  hideAlert();
  btnJoinGame.disabled = true;

  try {
    await joinRoom(inviteRoomId, name);
    const { room, players } = await fetchRoom(inviteRoomId);
    showLobbyView(room, players);
  } catch (err) {
    showAlert(err.message || 'Failed to join room.');
  } finally {
    btnJoinGame.disabled = false;
  }
}

btnJoinGame.addEventListener('click', handleJoinRoom);
joinPlayerName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleJoinRoom();
});

// --- Lobby Controls ---
btnCopyLink.addEventListener('click', async () => {
  if (!currentRoom) return;
  const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${currentRoom.id}`;
  try {
    await navigator.clipboard.writeText(inviteUrl);
    const originalText = btnCopyLink.textContent;
    btnCopyLink.textContent = '✓ Copied!';
    setTimeout(() => {
      btnCopyLink.textContent = originalText;
    }, 2000);
  } catch {
    showAlert(`Invite link: ${inviteUrl}`, 'info');
  }
});



btnLeaveRoom.addEventListener('click', async () => {
  if (!currentRoom) return;
  try {
    await leaveRoom(currentRoom.id);
  } catch (err) {
    console.error('Error leaving room:', err);
  }
  showLandingView();
});

btnStartGame.addEventListener('click', () => {
  showAlert('All players are ready! Game starting logic will follow here.', 'info');
});

// --- App Initialization ---
async function init() {
  try {
    currentUser = await ensureAnonymousSession();
  } catch (err) {
    showAlert('Could not initialize anonymous guest session: ' + err.message);
    return;
  }

  const inviteRoomId = getQueryParam('room');

  if (inviteRoomId) {
    // Visitor followed an invite link -> show the Join Game card
    hostCard.classList.add('hidden');
    joinCard.classList.remove('hidden');
    joinPlayerName.value = getSavedName();
    joinPlayerName.focus();
  } else {
    // Standard visitor -> show only the Host a Game card
    hostCard.classList.remove('hidden');
    joinCard.classList.add('hidden');
  }
}

init();

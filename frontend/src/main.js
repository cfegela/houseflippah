import './style.css';
import QRCode from 'qrcode';
import {
  ensureAnonymousSession,
  createRoom,
  joinRoom,
  fetchRoom,
  leaveRoom,
  subscribeToRoom,
  startGame,
  buyProperty,
  endTurn,
  fetchGameData,
} from './supabase.js';

// Application State
let currentUser = null;
let currentRoom = null;
let currentPlayers = [];
let catalogProperties = [];
let gameProperties = [];
let unsubscribeRealtime = null;

// DOM Elements - Alerts
const alertBox = document.getElementById('alert-box');
const alertMsg = document.getElementById('alert-msg');
const alertClose = document.getElementById('alert-close');

// DOM Elements - Views
const landingView = document.getElementById('landing-view');
const lobbyView = document.getElementById('lobby-view');
const gameView = document.getElementById('game-view');

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
const hostInviteControls = document.getElementById('host-invite-controls');
const btnCopyLink = document.getElementById('btn-copy-link');
const btnShowQr = document.getElementById('btn-show-qr');
const qrModal = document.getElementById('qr-modal');
const qrCanvas = document.getElementById('qr-canvas');
const btnCloseQr = document.getElementById('btn-close-qr');
const playerCountEl = document.getElementById('player-count');
const seatsGrid = document.getElementById('seats-grid');

const lobbyWaitMsg = document.getElementById('lobby-wait-msg');
const btnStartGame = document.getElementById('btn-start-game');

// DOM Elements - Game HUD & Marketplace
const turnIndicatorBox = document.getElementById('turn-indicator-box');
const turnPlayerDisplay = document.getElementById('turn-player-display');
const myWalletDisplay = document.getElementById('my-wallet-display');
const btnEndTurn = document.getElementById('btn-end-turn');
const btnGameEnd = document.getElementById('btn-game-end');
const propertiesGrid = document.getElementById('properties-grid');

// Helpers
function formatMoney(amount) {
  return '$' + Number(amount || 0).toLocaleString('en-US');
}

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

// Generate SVG architectural placeholder card graphic
function getPropertySvgPlaceholder(colorHex) {
  return `
    <svg viewBox="0 0 400 180" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">
      <defs>
        <linearGradient id="bg-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#1e293b"/>
          <stop offset="100%" stop-color="#0f172a"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#bg-grad)"/>
      <circle cx="200" cy="110" r="90" fill="${colorHex}" opacity="0.12"/>
      <polygon points="200,35 120,95 280,95" fill="${colorHex}" opacity="0.85"/>
      <rect x="140" y="95" width="120" height="65" fill="#334155"/>
      <rect x="185" y="115" width="30" height="45" fill="${colorHex}" opacity="0.95"/>
      <rect x="150" y="108" width="22" height="22" rx="3" fill="#cbd5e1" opacity="0.75"/>
      <rect x="228" y="108" width="22" height="22" rx="3" fill="#cbd5e1" opacity="0.75"/>
    </svg>
  `;
}

// Render Seats UI for Lobby
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
      if (hostInviteControls) hostInviteControls.classList.remove('hidden');
      btnStartGame.classList.remove('hidden');
      if (lobbyWaitMsg) lobbyWaitMsg.classList.add('hidden');
      const canStart = currentPlayers.length >= 1;
      btnStartGame.disabled = !canStart;
      btnStartGame.title = 'Start Game';
    } else {
      if (hostInviteControls) hostInviteControls.classList.add('hidden');
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
  gameView.classList.add('hidden');
  lobbyView.classList.remove('hidden');

  setRoomUrl(room.id);
  renderSeats();
  setupRealtimeSubscription(room.id);
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
  closeQrModal();

  document.getElementById('app').classList.remove('in-lobby');
  lobbyView.classList.add('hidden');
  gameView.classList.add('hidden');
  landingView.classList.remove('hidden');

  hostCard.classList.remove('hidden');
  joinCard.classList.add('hidden');
}

// Switch to Active Game View
async function loadAndShowGameView() {
  try {
    const data = await fetchGameData(currentRoom.id);
    currentRoom = data.room;
    currentPlayers = data.players;
    catalogProperties = data.catalog;
    gameProperties = data.gameProperties;

    document.getElementById('app').classList.add('in-lobby');
    landingView.classList.add('hidden');
    lobbyView.classList.add('hidden');
    gameView.classList.remove('hidden');

    renderGameHUD();
    renderProperties();
    setupRealtimeSubscription(currentRoom.id);
  } catch (err) {
    showAlert('Failed to load game: ' + err.message);
  }
}

// Render HUD (Turn indicator, wallet balance, scoreboard)
function renderGameHUD() {
  const myPlayer = currentPlayers.find((p) => p.user_id === currentUser.id);
  const activeSeat = currentRoom.current_turn_seat || 1;
  const activePlayer = currentPlayers.find((p) => p.seat_number === activeSeat);
  const isMyTurn = myPlayer && myPlayer.seat_number === activeSeat;

  // Turn Indicator Box
  if (activePlayer) {
    turnPlayerDisplay.textContent = `Seat ${activeSeat}: ${activePlayer.display_name}`;
  } else {
    turnPlayerDisplay.textContent = `Seat ${activeSeat}`;
  }

  if (isMyTurn) {
    turnIndicatorBox.classList.add('is-my-turn');
    btnEndTurn.disabled = false;
    btnEndTurn.title = 'Pass turn to next player';
  } else {
    turnIndicatorBox.classList.remove('is-my-turn');
    btnEndTurn.disabled = true;
    btnEndTurn.title = 'Waiting for your turn';
  }

  // Wallet
  if (myPlayer) {
    myWalletDisplay.textContent = formatMoney(myPlayer.cash);
  }

  // Host Controls
  if (myPlayer?.is_host) {
    btnGameEnd.classList.remove('hidden');
  } else {
    btnGameEnd.classList.add('hidden');
  }
}

// Render Zillow-Style Properties Feed
function renderProperties() {
  propertiesGrid.innerHTML = '';

  const myPlayer = currentPlayers.find((p) => p.user_id === currentUser.id);
  const activeSeat = currentRoom.current_turn_seat || 1;
  const isMyTurn = myPlayer && myPlayer.seat_number === activeSeat;

  catalogProperties.forEach((prop) => {
    const gp = gameProperties.find((g) => g.property_slug === prop.slug);
    const ownerId = gp?.owner_user_id;
    const isOwned = !!ownerId;
    const isMine = ownerId === currentUser.id;
    const ownerPlayer = isOwned ? currentPlayers.find((p) => p.user_id === ownerId) : null;

    const canAfford = myPlayer && myPlayer.cash >= prop.cost;

    const card = document.createElement('div');
    card.className = 'zillow-card';

    // Image & Status Header
    let statusBadgeHtml = '';
    if (!isOwned) {
      statusBadgeHtml = `<span class="listing-badge badge-for-sale">FOR SALE</span>`;
    } else if (isMine) {
      statusBadgeHtml = `<span class="listing-badge badge-owned-by-you">YOUR DEED</span>`;
    } else {
      statusBadgeHtml = `<span class="listing-badge badge-sold">SOLD • ${escapeHtml(ownerPlayer?.display_name || 'Player')}</span>`;
    }

    // Action button
    let actionBtnHtml = '';
    if (!isOwned) {
      if (isMyTurn) {
        if (canAfford) {
          actionBtnHtml = `<button class="btn-buy" data-slug="${prop.slug}">Buy Property (${formatMoney(prop.cost)})</button>`;
        } else {
          actionBtnHtml = `<button class="btn-buy" disabled>Need ${formatMoney(prop.cost - myPlayer.cash)} More</button>`;
        }
      } else {
        actionBtnHtml = `<button class="btn-buy" disabled>Waiting for Turn</button>`;
      }
    } else {
      actionBtnHtml = `<button class="btn-buy" disabled style="background: #1e293b; color: var(--text-muted);">Owned by ${escapeHtml(ownerPlayer?.display_name || 'Opponent')}</button>`;
    }

    card.innerHTML = `
      <div class="card-color-stripe" style="background-color: ${prop.color_hex};"></div>
      <div class="card-img-placeholder">
        <div class="card-img-badge-row" style="justify-content: flex-end;">
          ${statusBadgeHtml}
        </div>
        <div style="position: absolute; inset: 0; z-index: 1;">
          ${getPropertySvgPlaceholder(prop.color_hex)}
        </div>
      </div>
      <div class="card-body">
        <div class="prop-price">${formatMoney(prop.cost)}</div>
        <div class="prop-specs">${prop.beds} bds • ${prop.baths} ba • ${prop.sqft.toLocaleString()} sqft</div>
        <div class="prop-name">${escapeHtml(prop.name)}</div>
      </div>
      <div class="card-footer">
        ${actionBtnHtml}
      </div>
    `;

    // Hook buy button
    const buyBtn = card.querySelector('.btn-buy:not(:disabled)');
    if (buyBtn) {
      buyBtn.addEventListener('click', async () => {
        buyBtn.disabled = true;
        buyBtn.textContent = 'Purchasing...';
        try {
          await buyProperty(currentRoom.id, prop.slug);
          // Realtime triggers re-render, but update locally for instant feel
          const { room, players, gameProperties: updatedProps } = await fetchGameData(currentRoom.id);
          currentRoom = room;
          currentPlayers = players;
          gameProperties = updatedProps;
          renderGameHUD();
          renderProperties();
        } catch (err) {
          showAlert(err.message || 'Failed to purchase property.');
          buyBtn.disabled = false;
          buyBtn.textContent = `Buy Property (${formatMoney(prop.cost)})`;
        }
      });
    }

    propertiesGrid.appendChild(card);
  });
}

// Realtime subscriptions
function setupRealtimeSubscription(roomId) {
  if (unsubscribeRealtime) unsubscribeRealtime();

  unsubscribeRealtime = subscribeToRoom(
    roomId,
    async () => {
      try {
        const { room: latestRoom, players: updatedPlayers } = await fetchRoom(roomId);
        if (latestRoom.status === 'abandoned') {
          showLandingView();
          showAlert('The game was ended by the host.', 'info');
          return;
        }
        currentPlayers = updatedPlayers;
        if (currentRoom.status === 'in_progress') {
          renderGameHUD();
          renderProperties();
        } else {
          renderSeats();
        }
      } catch (err) {
        showLandingView();
        showAlert('The game was ended by the host.', 'info');
      }
    },
    async (roomChange) => {
      if (roomChange.new) {
        currentRoom = roomChange.new;
        if (currentRoom.status === 'in_progress') {
          await loadAndShowGameView();
        } else if (currentRoom.status === 'abandoned') {
          showLandingView();
          showAlert('The game was ended by the host.', 'info');
        }
      }
    },
    async () => {
      // Game property ownership changes
      try {
        const { gameProperties: updatedProps, players: updatedPlayers } = await fetchGameData(roomId);
        gameProperties = updatedProps;
        currentPlayers = updatedPlayers;
        renderGameHUD();
        renderProperties();
      } catch (err) {
        console.error('Error refreshing properties:', err);
      }
    }
  );
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

hostModal.addEventListener('click', (e) => {
  if (e.target === hostModal) closeHostModal();
});

// --- Join Room Flow ---
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
    if (room.status === 'in_progress') {
      currentRoom = room;
      currentPlayers = players;
      await loadAndShowGameView();
    } else {
      showLobbyView(room, players);
    }
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
    btnCopyLink.textContent = 'Copied!';
    setTimeout(() => {
      btnCopyLink.textContent = originalText;
    }, 2000);
  } catch {
    showAlert(`Invite link: ${inviteUrl}`, 'info');
  }
});

function openQrModal() {
  if (!currentRoom) return;
  const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${currentRoom.id}`;
  QRCode.toCanvas(
    qrCanvas,
    inviteUrl,
    {
      width: 230,
      margin: 1,
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
    },
    (err) => {
      if (err) console.error('Failed to generate QR code:', err);
    }
  );
  qrModal.classList.remove('hidden');
}

function closeQrModal() {
  qrModal.classList.add('hidden');
}

btnShowQr.addEventListener('click', openQrModal);
btnCloseQr.addEventListener('click', closeQrModal);
qrModal.addEventListener('click', (e) => {
  if (e.target === qrModal) closeQrModal();
});

// Host Starts Game
btnStartGame.addEventListener('click', async () => {
  if (!currentRoom) return;
  btnStartGame.disabled = true;
  try {
    await startGame(currentRoom.id);
    await loadAndShowGameView();
  } catch (err) {
    showAlert(err.message || 'Failed to start game.');
    btnStartGame.disabled = false;
  }
});

// Gameplay HUD Actions
btnEndTurn.addEventListener('click', async () => {
  if (!currentRoom) return;
  btnEndTurn.disabled = true;
  try {
    const { room } = await endTurn(currentRoom.id);
    currentRoom = room;
    renderGameHUD();
    renderProperties();
  } catch (err) {
    showAlert(err.message || 'Failed to end turn.');
    btnEndTurn.disabled = false;
  }
});

btnGameEnd.addEventListener('click', async () => {
  if (!currentRoom) return;
  const wasRoomId = currentRoom.id;
  try {
    await leaveRoom(wasRoomId);
  } catch (err) {
    console.error('Error ending game:', err);
  }
  showLandingView();
  showAlert('You ended the game.', 'info');
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
    hostCard.classList.add('hidden');
    joinCard.classList.remove('hidden');
    joinPlayerName.value = getSavedName();
    joinPlayerName.focus();
  } else {
    hostCard.classList.remove('hidden');
    joinCard.classList.add('hidden');
  }
}

init();

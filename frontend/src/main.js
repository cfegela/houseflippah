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
  makeMortgagePayment,
  endTurn,
  fetchGameData,
} from './supabase.js';

// Application State
let currentUser = null;
let currentRoom = null;
let currentPlayers = [];
let catalogProperties = [];
let gameProperties = [];
let currentGameSubpage = 'dashboard';
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
const roundNumberDisplay = document.getElementById('round-number-display');
const turnPlayerDisplay = document.getElementById('turn-player-display');
const myWalletDisplay = document.getElementById('my-wallet-display');
const btnEndTurn = document.getElementById('btn-end-turn');
const btnGameEnd = document.getElementById('btn-game-end');
const propertiesGrid = document.getElementById('properties-grid');

// DOM Elements - Active Game Subpages & Navigation
const gameDashboardView = document.getElementById('game-dashboard-view');
const gameBuyPropertiesView = document.getElementById('game-buy-properties-view');
const gameMakePaymentsView = document.getElementById('game-make-payments-view');
const mortgagePaymentsContainer = document.getElementById('mortgage-payments-container');
const gamePlaceholderView = document.getElementById('game-placeholder-view');
const placeholderHeaderTitle = document.getElementById('placeholder-header-title');
const placeholderIcon = document.getElementById('placeholder-icon');
const placeholderCardTitle = document.getElementById('placeholder-card-title');
const placeholderCardDesc = document.getElementById('placeholder-card-desc');

const cardNavBuyProperties = document.getElementById('card-nav-buy-properties');
const cardNavSellProperties = document.getElementById('card-nav-sell-properties');
const cardNavMakeImprovements = document.getElementById('card-nav-make-improvements');
const cardNavMakePayments = document.getElementById('card-nav-make-payments');
const cardNavMarketReport = document.getElementById('card-nav-market-report');
const cardNavFinancialReport = document.getElementById('card-nav-financial-report');

// DOM Elements - End Game Modal
const endGameModal = document.getElementById('end-game-modal');
const btnCancelEndGame = document.getElementById('btn-cancel-end-game');
const btnConfirmEndGame = document.getElementById('btn-confirm-end-game');

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
  currentGameSubpage = 'dashboard';
  setRoomUrl(null);
  closeQrModal();
  closeEndGameModal();

  document.getElementById('app').classList.remove('in-lobby');
  lobbyView.classList.add('hidden');
  gameView.classList.add('hidden');
  landingView.classList.remove('hidden');

  hostCard.classList.remove('hidden');
  joinCard.classList.add('hidden');
}

// Game Subpage Navigation
function showGameSubpage(subpage, placeholderInfo = null) {
  currentGameSubpage = subpage;
  if (!gameDashboardView || !gameBuyPropertiesView || !gamePlaceholderView || !gameMakePaymentsView) return;

  if (subpage === 'dashboard') {
    gameDashboardView.classList.remove('hidden');
    gameBuyPropertiesView.classList.add('hidden');
    gamePlaceholderView.classList.add('hidden');
    gameMakePaymentsView.classList.add('hidden');
  } else if (subpage === 'buy-properties') {
    gameDashboardView.classList.add('hidden');
    gameBuyPropertiesView.classList.remove('hidden');
    gamePlaceholderView.classList.add('hidden');
    gameMakePaymentsView.classList.add('hidden');
    renderProperties();
  } else if (subpage === 'make-payments') {
    gameDashboardView.classList.add('hidden');
    gameBuyPropertiesView.classList.add('hidden');
    gamePlaceholderView.classList.add('hidden');
    gameMakePaymentsView.classList.remove('hidden');
    renderMortgagePayments();
  } else if (subpage === 'placeholder') {
    gameDashboardView.classList.add('hidden');
    gameBuyPropertiesView.classList.add('hidden');
    gameMakePaymentsView.classList.add('hidden');
    gamePlaceholderView.classList.remove('hidden');
    if (placeholderInfo) {
      placeholderHeaderTitle.textContent = placeholderInfo.title;
      placeholderIcon.textContent = placeholderInfo.icon;
      placeholderCardTitle.textContent = placeholderInfo.title;
      placeholderCardDesc.textContent = placeholderInfo.desc;
    }
  }
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
    showGameSubpage(currentGameSubpage || 'dashboard');
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

  // Turn & Round Indicator Box
  if (roundNumberDisplay && currentRoom) {
    roundNumberDisplay.textContent = currentRoom.current_round || 1;
  }
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
        actionBtnHtml = `<button class="btn-buy" data-slug="${prop.slug}">Buy Property</button>`;
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
        <div style="font-size: 0.8rem; color: #38bdf8; font-weight: 600; margin-top: 0.15rem;">
          10% Down: ${formatMoney((prop.cost * 10) / 100)} • ${formatMoney(prop.cost / 40)}/rd
        </div>
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
          if (currentGameSubpage === 'make-payments') renderMortgagePayments();
        } catch (err) {
          showAlert(err.message || 'Failed to purchase property.');
          buyBtn.disabled = false;
          buyBtn.textContent = 'Buy Property';
        }
      });
    }

    propertiesGrid.appendChild(card);
  });
}

// Render Mortgage & Make Payments List
function renderMortgagePayments() {
  if (!mortgagePaymentsContainer) return;
  mortgagePaymentsContainer.innerHTML = '';

  const myPlayer = currentPlayers.find((p) => p.user_id === currentUser.id);
  const activeSeat = currentRoom.current_turn_seat || 1;
  const isMyTurn = myPlayer && myPlayer.seat_number === activeSeat;
  const currentRound = currentRoom.current_round || 1;

  // Filter player's owned properties
  const myProperties = gameProperties.filter((gp) => gp.owner_user_id === currentUser.id);

  if (myProperties.length === 0) {
    mortgagePaymentsContainer.innerHTML = `
      <div class="card placeholder-card">
        <div style="font-size: 3rem; margin-bottom: 1rem;">💳</div>
        <h3 style="margin-bottom: 0.5rem; font-size: 1.35rem;">No Active Mortgages</h3>
        <p style="color: var(--text-muted); max-width: 460px; margin: 0 auto 1.5rem auto; line-height: 1.5;">
          You don't own any properties yet. Head over to <strong>Buy Properties</strong> on your turn to finance your first real estate deed with 10% down!
        </p>
        <button class="btn btn-primary" id="btn-goto-buy-properties" style="padding: 0.65rem 1.5rem;">
          Browse Properties
        </button>
      </div>
    `;
    const gotoBtn = document.getElementById('btn-goto-buy-properties');
    if (gotoBtn) gotoBtn.addEventListener('click', () => showGameSubpage('buy-properties'));
    return;
  }

  myProperties.forEach((gp) => {
    const catalog = catalogProperties.find((cp) => cp.slug === gp.property_slug);
    if (!catalog) return;

    const basePayment = catalog.cost / 40;
    const isDelinquent = (gp.missed_payments || 0) >= 1;
    const isPaidThisRound = !isDelinquent && (gp.last_paid_round || 0) >= currentRound;
    const requiredPayment = isDelinquent ? basePayment * 2 : basePayment;

    const card = document.createElement('div');
    card.className = `mortgage-card ${isDelinquent ? 'is-delinquent' : ''}`;

    let statusBadge = '';
    let warningBox = '';
    let actionBtnHtml = '';

    if (isPaidThisRound) {
      statusBadge = `<span class="badge badge-paid">PAID FOR ROUND ${currentRound} ✓</span>`;
      actionBtnHtml = `<button class="btn-pay-mortgage" disabled>Paid for Round ${currentRound}</button>`;
    } else if (isDelinquent) {
      statusBadge = `<span class="badge badge-delinquent">⚠️ DELINQUENT • 1 MISSED</span>`;
      warningBox = `
        <div class="mortgage-warning-box">
          <strong>⚠️ Final Foreclosure Warning:</strong> You missed payment last round. Pay double <strong>(${formatMoney(requiredPayment)})</strong> this round to bring your mortgage current, or the bank will foreclose and repossess the property when the round ends!
        </div>
      `;
      if (isMyTurn) {
        actionBtnHtml = `<button class="btn-pay-mortgage btn-pay-delinquent" data-slug="${catalog.slug}">Pay Double (${formatMoney(requiredPayment)})</button>`;
      } else {
        actionBtnHtml = `<button class="btn-pay-mortgage" disabled>Waiting for Turn</button>`;
      }
    } else {
      statusBadge = `<span class="badge badge-due">DUE ROUND ${currentRound}</span>`;
      if (isMyTurn) {
        actionBtnHtml = `<button class="btn-pay-mortgage" data-slug="${catalog.slug}">Pay Mortgage (${formatMoney(requiredPayment)})</button>`;
      } else {
        actionBtnHtml = `<button class="btn-pay-mortgage" disabled>Waiting for Turn</button>`;
      }
    }

    card.innerHTML = `
      <div class="card-color-stripe" style="background-color: ${catalog.color_hex};"></div>
      <div class="mortgage-card-header">
        <div>
          <h3 style="font-size: 1.25rem; font-weight: 700;">${escapeHtml(catalog.name)}</h3>
          <span style="font-size: 0.8rem; color: var(--text-muted);">${escapeHtml(catalog.group_name)}</span>
        </div>
        ${statusBadge}
      </div>
      <div class="mortgage-card-body">
        <div class="mortgage-stat">
          <span class="mortgage-stat-label">Property Value</span>
          <span class="mortgage-stat-val">${formatMoney(catalog.cost)}</span>
        </div>
        <div class="mortgage-stat">
          <span class="mortgage-stat-label">Round Payment (2.5%)</span>
          <span class="mortgage-stat-val" style="color: #38bdf8;">${formatMoney(basePayment)}</span>
        </div>
        <div class="mortgage-stat">
          <span class="mortgage-stat-label">Amount Due Now</span>
          <span class="mortgage-stat-val" style="color: ${isDelinquent ? '#f59e0b' : '#22c55e'};">
            ${isPaidThisRound ? '$0' : formatMoney(requiredPayment)}
          </span>
        </div>
      </div>
      ${warningBox}
      <div class="mortgage-card-footer">
        ${actionBtnHtml}
      </div>
    `;

    // Hook payment button
    const payBtn = card.querySelector('.btn-pay-mortgage:not(:disabled)');
    if (payBtn) {
      payBtn.addEventListener('click', async () => {
        payBtn.disabled = true;
        payBtn.textContent = 'Processing Payment...';
        try {
          await makeMortgagePayment(currentRoom.id, catalog.slug);
          const { room, players, gameProperties: updatedProps } = await fetchGameData(currentRoom.id);
          currentRoom = room;
          currentPlayers = players;
          gameProperties = updatedProps;
          renderGameHUD();
          renderMortgagePayments();
          renderProperties();
          showAlert(`Mortgage payment of ${formatMoney(requiredPayment)} processed successfully!`, 'success');
        } catch (err) {
          showAlert(err.message || 'Failed to make mortgage payment.');
          payBtn.disabled = false;
        }
      });
    }

    mortgagePaymentsContainer.appendChild(card);
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
          if (currentGameSubpage === 'make-payments') renderMortgagePayments();
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
        if (currentGameSubpage === 'make-payments') renderMortgagePayments();
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

function openEndGameModal() {
  endGameModal.classList.remove('hidden');
}

function closeEndGameModal() {
  endGameModal.classList.add('hidden');
}

btnGameEnd.addEventListener('click', openEndGameModal);
btnCancelEndGame.addEventListener('click', closeEndGameModal);

endGameModal.addEventListener('click', (e) => {
  if (e.target === endGameModal) closeEndGameModal();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!endGameModal.classList.contains('hidden')) closeEndGameModal();
    if (!qrModal.classList.contains('hidden')) closeQrModal();
  }
});

btnConfirmEndGame.addEventListener('click', async () => {
  if (!currentRoom) return;
  const wasRoomId = currentRoom.id;
  btnConfirmEndGame.disabled = true;
  closeEndGameModal();
  try {
    await leaveRoom(wasRoomId);
  } catch (err) {
    console.error('Error ending game:', err);
  } finally {
    btnConfirmEndGame.disabled = false;
  }
  showLandingView();
  showAlert('You ended the game.', 'info');
});

// Dashboard Hub Card Navigation
if (cardNavBuyProperties) {
  cardNavBuyProperties.addEventListener('click', () => showGameSubpage('buy-properties'));
  cardNavBuyProperties.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') showGameSubpage('buy-properties');
  });
}

if (cardNavSellProperties) {
  cardNavSellProperties.addEventListener('click', () =>
    showGameSubpage('placeholder', {
      title: 'Sell Properties',
      icon: '🏷️',
      desc: 'List properties for sale to other players and the bank. This feature will be introduced in an upcoming phase.'
    })
  );
  cardNavSellProperties.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') cardNavSellProperties.click();
  });
}

if (cardNavMakeImprovements) {
  cardNavMakeImprovements.addEventListener('click', () =>
    showGameSubpage('placeholder', {
      title: 'Make Improvements',
      icon: '🔨',
      desc: 'Renovate properties, build houses, and increase appraisal value across your real estate holdings. Coming in an upcoming phase.'
    })
  );
  cardNavMakeImprovements.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') cardNavMakeImprovements.click();
  });
}

if (cardNavMakePayments) {
  cardNavMakePayments.addEventListener('click', () => showGameSubpage('make-payments'));
  cardNavMakePayments.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') cardNavMakePayments.click();
  });
}

if (cardNavMarketReport) {
  cardNavMarketReport.addEventListener('click', () =>
    showGameSubpage('placeholder', {
      title: 'Market Report',
      icon: '📈',
      desc: 'Review market conditions and see recent transactions. This feature will be introduced in an upcoming phase.'
    })
  );
  cardNavMarketReport.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') cardNavMarketReport.click();
  });
}

if (cardNavFinancialReport) {
  cardNavFinancialReport.addEventListener('click', () =>
    showGameSubpage('placeholder', {
      title: 'Financial Report',
      icon: '📊',
      desc: 'Check your account balance and review spending. This feature will be introduced in an upcoming phase.'
    })
  );
  cardNavFinancialReport.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') cardNavFinancialReport.click();
  });
}

document.querySelectorAll('.btn-back-to-dashboard').forEach((btn) => {
  btn.addEventListener('click', () => showGameSubpage('dashboard'));
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

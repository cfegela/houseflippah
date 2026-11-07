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
  listProperty,
  delistProperty,
  makeImprovement,
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
let selectedPropertySlug = null;
let unsubscribeRealtime = null;
let lastKnownTurnKey = null;

// Audio Alert System (Web Audio API)
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx && typeof window !== 'undefined') {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  return audioCtx;
}

function unlockAudio() {
  const ctx = getAudioContext();
  if (ctx) {
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    // Warm up audio buffer for iOS/mobile Web Audio activation
    try {
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch (_) {}
  }
}

if (typeof window !== 'undefined') {
  ['click', 'touchstart', 'pointerdown', 'keydown'].forEach((eventName) => {
    window.addEventListener(eventName, unlockAudio, { passive: true });
  });
}

async function playTurnChime() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;
    // Pleasant ascending melodic chime: C5 (523Hz) -> E5 (659Hz) -> G5 (784Hz)
    const notes = [
      { freq: 523.25, time: now, dur: 0.3, peak: 0.18 },
      { freq: 659.25, time: now + 0.09, dur: 0.3, peak: 0.2 },
      { freq: 783.99, time: now + 0.18, dur: 0.55, peak: 0.25 },
    ];

    notes.forEach(({ freq, time, dur, peak }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, time);

      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(peak, time + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(time);
      osc.stop(time + dur);
    });

    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate([60, 40, 60]);
    }
  } catch (err) {
    console.warn('Could not play turn chime:', err);
  }
}

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
const gamePropertyDetailsView = document.getElementById('game-property-details-view');
const propertyDetailsContainer = document.getElementById('property-details-container');
const gameSellPropertiesView = document.getElementById('game-sell-properties-view');
const sellPropertiesContainer = document.getElementById('sell-properties-container');
const gameMakeImprovementsView = document.getElementById('game-make-improvements-view');
const makeImprovementsContainer = document.getElementById('make-improvements-container');
const gameMakePaymentsView = document.getElementById('game-make-payments-view');
const mortgagePaymentsContainer = document.getElementById('mortgage-payments-container');
const gameFinancialReportView = document.getElementById('game-financial-report-view');
const financialReportContainer = document.getElementById('financial-report-container');
const gameMarketReportView = document.getElementById('game-market-report-view');
const marketReportContainer = document.getElementById('market-report-container');

// Improvements Catalog Definition
const IMPROVEMENTS_CATALOG = [
  { key: 'windows_doors', name: 'Windows & Doors', icon: '🪟', desc: 'Energy-efficient insulated windows and modern entry doors.' },
  { key: 'hvac_mechanicals', name: 'HVAC & Mechanicals', icon: '❄️', desc: 'High-efficiency heat pump, ductwork, and electrical panel upgrade.' },
  { key: 'roof_siding', name: 'Roof & Siding', icon: '🏠', desc: 'Architectural shingles and durable weather-resistant siding.' },
  { key: 'flooring_painting', name: 'Flooring & Painting', icon: '🎨', desc: 'Hardwood refinishing, luxury vinyl tile, and interior/exterior paint.' },
  { key: 'kitchen_baths', name: 'Kitchen & Baths', icon: '🍳', desc: 'Quartz countertops, custom cabinetry, tile showers, and fixtures.' }
];
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

// DOM Elements - Purchase Confirmation Modal
const purchaseConfirmModal = document.getElementById('purchase-confirm-modal');
const modalPropertyName = document.getElementById('modal-property-name');
const modalPropTotalCost = document.getElementById('modal-prop-total-cost');
const modalPropDownPayment = document.getElementById('modal-prop-down-payment');
const modalPropMortgage = document.getElementById('modal-prop-mortgage');
const modalPropRemainingCash = document.getElementById('modal-prop-remaining-cash');
const btnCancelPurchase = document.getElementById('btn-cancel-purchase');
const btnConfirmPurchase = document.getElementById('btn-confirm-purchase');

let pendingPurchaseProperty = null;

// DOM Elements - List Property Modal
const listPropertyModal = document.getElementById('list-property-modal');
const modalListPropertyName = document.getElementById('modal-list-property-name');
const modalListPropertyBaseCost = document.getElementById('modal-list-property-base-cost');
const modalListPriceInput = document.getElementById('modal-list-price-input');
const btnCancelListProperty = document.getElementById('btn-cancel-list-property');
const btnConfirmListProperty = document.getElementById('btn-confirm-list-property');

let pendingListProperty = null;

// DOM Elements - Improve Property Modal
const improvePropertyModal = document.getElementById('improve-property-modal');
const modalImprovePropertyName = document.getElementById('modal-improve-property-name');
const modalImprovePropertySubtitle = document.getElementById('modal-improve-property-subtitle');
const modalImproveProgress = document.getElementById('modal-improve-progress');
const modalImproveMarketValue = document.getElementById('modal-improve-market-value');
const modalImprovePurchasePrice = document.getElementById('modal-improve-purchase-price');
const modalImprovePlayerCash = document.getElementById('modal-improve-player-cash');
const modalImprovementsList = document.getElementById('modal-improvements-list');
const btnCloseImproveModal = document.getElementById('btn-close-improve-modal');

let pendingImproveProperty = null;

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
    <svg viewBox="0 0 400 180" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="bg-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#1e293b"/>
          <stop offset="100%" stop-color="#0f172a"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#bg-grad)" class="svg-bg-rect"/>
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
  const myPlayer = currentPlayers.find((p) => p.user_id === currentUser?.id);

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
  lastKnownTurnKey = null;
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

  // The Financial Report and Market Report are visible only on their own subpages
  if (gameFinancialReportView) gameFinancialReportView.classList.toggle('hidden', subpage !== 'financial-report');
  if (gameMarketReportView) gameMarketReportView.classList.toggle('hidden', subpage !== 'market-report');

  if (subpage === 'dashboard') {
    gameDashboardView.classList.remove('hidden');
    gameBuyPropertiesView.classList.add('hidden');
    if (gamePropertyDetailsView) gamePropertyDetailsView.classList.add('hidden');
    if (gameSellPropertiesView) gameSellPropertiesView.classList.add('hidden');
    if (gameMakeImprovementsView) gameMakeImprovementsView.classList.add('hidden');
    gamePlaceholderView.classList.add('hidden');
    gameMakePaymentsView.classList.add('hidden');
  } else if (subpage === 'buy-properties') {
    gameDashboardView.classList.add('hidden');
    gameBuyPropertiesView.classList.remove('hidden');
    if (gamePropertyDetailsView) gamePropertyDetailsView.classList.add('hidden');
    if (gameSellPropertiesView) gameSellPropertiesView.classList.add('hidden');
    if (gameMakeImprovementsView) gameMakeImprovementsView.classList.add('hidden');
    gamePlaceholderView.classList.add('hidden');
    gameMakePaymentsView.classList.add('hidden');
    renderProperties();
  } else if (subpage === 'property-details') {
    gameDashboardView.classList.add('hidden');
    gameBuyPropertiesView.classList.add('hidden');
    if (gamePropertyDetailsView) gamePropertyDetailsView.classList.remove('hidden');
    if (gameSellPropertiesView) gameSellPropertiesView.classList.add('hidden');
    if (gameMakeImprovementsView) gameMakeImprovementsView.classList.add('hidden');
    gamePlaceholderView.classList.add('hidden');
    gameMakePaymentsView.classList.add('hidden');
    if (selectedPropertySlug) renderPropertyDetails(selectedPropertySlug);
  } else if (subpage === 'sell-properties') {
    gameDashboardView.classList.add('hidden');
    gameBuyPropertiesView.classList.add('hidden');
    if (gamePropertyDetailsView) gamePropertyDetailsView.classList.add('hidden');
    if (gameSellPropertiesView) gameSellPropertiesView.classList.remove('hidden');
    if (gameMakeImprovementsView) gameMakeImprovementsView.classList.add('hidden');
    gamePlaceholderView.classList.add('hidden');
    gameMakePaymentsView.classList.add('hidden');
    renderSellProperties();
  } else if (subpage === 'make-improvements') {
    gameDashboardView.classList.add('hidden');
    gameBuyPropertiesView.classList.add('hidden');
    if (gamePropertyDetailsView) gamePropertyDetailsView.classList.add('hidden');
    if (gameSellPropertiesView) gameSellPropertiesView.classList.add('hidden');
    if (gameMakeImprovementsView) gameMakeImprovementsView.classList.remove('hidden');
    gamePlaceholderView.classList.add('hidden');
    gameMakePaymentsView.classList.add('hidden');
    renderMakeImprovements();
  } else if (subpage === 'make-payments') {
    gameDashboardView.classList.add('hidden');
    gameBuyPropertiesView.classList.add('hidden');
    if (gamePropertyDetailsView) gamePropertyDetailsView.classList.add('hidden');
    if (gameSellPropertiesView) gameSellPropertiesView.classList.add('hidden');
    if (gameMakeImprovementsView) gameMakeImprovementsView.classList.add('hidden');
    gamePlaceholderView.classList.add('hidden');
    gameMakePaymentsView.classList.remove('hidden');
    renderMortgagePayments();
  } else if (subpage === 'financial-report') {
    gameDashboardView.classList.add('hidden');
    gameBuyPropertiesView.classList.add('hidden');
    if (gamePropertyDetailsView) gamePropertyDetailsView.classList.add('hidden');
    if (gameSellPropertiesView) gameSellPropertiesView.classList.add('hidden');
    if (gameMakeImprovementsView) gameMakeImprovementsView.classList.add('hidden');
    gamePlaceholderView.classList.add('hidden');
    gameMakePaymentsView.classList.add('hidden');
    renderFinancialReport();
  } else if (subpage === 'market-report') {
    gameDashboardView.classList.add('hidden');
    gameBuyPropertiesView.classList.add('hidden');
    if (gamePropertyDetailsView) gamePropertyDetailsView.classList.add('hidden');
    if (gameSellPropertiesView) gameSellPropertiesView.classList.add('hidden');
    if (gameMakeImprovementsView) gameMakeImprovementsView.classList.add('hidden');
    gamePlaceholderView.classList.add('hidden');
    gameMakePaymentsView.classList.add('hidden');
    renderMarketReport();
  } else if (subpage === 'placeholder') {
    gameDashboardView.classList.add('hidden');
    gameBuyPropertiesView.classList.add('hidden');
    if (gamePropertyDetailsView) gamePropertyDetailsView.classList.add('hidden');
    if (gameSellPropertiesView) gameSellPropertiesView.classList.add('hidden');
    if (gameMakeImprovementsView) gameMakeImprovementsView.classList.add('hidden');
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
  const myPlayer = currentPlayers.find((p) => p.user_id === currentUser?.id);
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

    const currentTurnKey = `${currentRoom.current_round || 1}:${activeSeat}`;
    if (lastKnownTurnKey !== currentTurnKey) {
      lastKnownTurnKey = currentTurnKey;
      playTurnChime();
    }
  } else {
    turnIndicatorBox.classList.remove('is-my-turn');
    btnEndTurn.disabled = true;
    btnEndTurn.title = 'Wait your turn';
  }

  // Wallet (if present)
  if (myPlayer && myWalletDisplay) {
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

  const availableProperties = catalogProperties.filter((prop) => {
    const gp = gameProperties.find((g) => g.property_slug === prop.slug);
    // Bank-owned properties are available for purchase
    if (!gp || !gp.owner_user_id) return true;
    // Resale properties listed by any player (including your own listings)
    if (gp.is_listed) return true;
    return false;
  });

  if (availableProperties.length === 0) {
    propertiesGrid.innerHTML = `
      <div class="card placeholder-card" style="grid-column: 1 / -1; padding: 3.5rem 1.5rem;">
        <div style="font-size: 3rem; margin-bottom: 1rem;">🏘️</div>
        <h3 style="margin-bottom: 0.5rem; font-size: 1.35rem;">No Properties Currently Available</h3>
        <p style="color: var(--text-muted); max-width: 460px; margin: 0 auto; line-height: 1.5;">
          All properties on the market have been purchased. Check back next round or monitor the market for foreclosures!
        </p>
      </div>
    `;
    return;
  }

  availableProperties.forEach((prop) => {
    const gp = gameProperties.find((g) => g.property_slug === prop.slug);
    const isResale = !!(gp && gp.is_listed);
    const isMyListing = isResale && gp.owner_user_id === currentUser?.id;
    const effectivePrice = isResale ? (gp.list_price || prop.cost) : prop.cost;

    const card = document.createElement('div');
    card.className = 'zillow-card';
    card.style.cursor = 'pointer';

    // Image & Status Header
    const installedImprovements = Array.isArray(gp?.improvements) ? gp.improvements : [];
    let statusBadgeHtml = '';
    if (isMyListing) {
      statusBadgeHtml = `<span class="listing-badge" style="background: #0284c7; color: #fff;">YOUR LISTING</span>`;
    } else if (isResale) {
      statusBadgeHtml = `<span class="listing-badge" style="background: #0284c7; color: #fff;">RESALE</span>`;
    } else if (installedImprovements.length > 0) {
      statusBadgeHtml = `<span class="listing-badge" style="background: #16a34a; color: #fff;">UPGRADED (${installedImprovements.length})</span>`;
    } else {
      statusBadgeHtml = `<span class="listing-badge badge-for-sale">FOR SALE</span>`;
    }

    const actionBtnHtml = `
      <button class="btn-view-property" data-slug="${prop.slug}">
        View Property →
      </button>
    `;

    card.innerHTML = `
      <div class="card-color-stripe" style="background-color: ${prop.color_hex};"></div>
      <div class="card-img-placeholder">
        <div class="card-img-badge-row" style="justify-content: flex-end;">
          ${statusBadgeHtml}
        </div>
        <div class="property-hero-graphic" style="position: absolute; inset: 0; z-index: 1;">
          ${getPropertySvgPlaceholder(prop.color_hex)}
        </div>
      </div>
      <div class="card-body">
        <div class="prop-price">${formatMoney(effectivePrice)}</div>
        <div class="prop-specs">${prop.beds} bds • ${prop.baths} ba • ${prop.sqft.toLocaleString()} sqft</div>
        <div style="font-size: 0.8rem; color: #38bdf8; font-weight: 600; margin-top: 0.15rem;">
          10% Down: ${formatMoney((effectivePrice * 10) / 100)} • ${formatMoney(effectivePrice / 40)}/rd
        </div>
        <div class="prop-name">${escapeHtml(prop.name)}</div>
      </div>
      <div class="card-footer">
        ${actionBtnHtml}
      </div>
    `;

    // Clicking card opens dedicated property details page
    card.addEventListener('click', () => {
      showPropertyDetails(prop.slug);
    });

    propertiesGrid.appendChild(card);
  });
}

// Show & Render Property Details Subpage
function showPropertyDetails(slug) {
  selectedPropertySlug = slug;
  showGameSubpage('property-details');
}

function renderPropertyDetails(slug) {
  if (!propertyDetailsContainer) return;
  propertyDetailsContainer.innerHTML = '';

  const prop = catalogProperties.find((p) => p.slug === slug);
  if (!prop) {
    propertyDetailsContainer.innerHTML = `
      <div class="card placeholder-card">
        <h3>Property Not Found</h3>
        <p style="color: var(--text-muted);">Could not locate details for "${escapeHtml(slug)}".</p>
        <button class="btn btn-secondary" id="btn-err-back">Keep Browsing</button>
      </div>
    `;
    const errBack = document.getElementById('btn-err-back');
    if (errBack) errBack.addEventListener('click', () => showGameSubpage('buy-properties'));
    return;
  }

  const gp = gameProperties.find((g) => g.property_slug === slug);
  const ownerId = gp?.owner_user_id;
  const isBankOwned = !ownerId;
  const isOwnedByMe = ownerId === currentUser?.id;
  const ownerPlayer = isBankOwned ? null : currentPlayers.find((p) => p.user_id === ownerId);

  const myPlayer = currentPlayers.find((p) => p.user_id === currentUser?.id);
  const activeSeat = currentRoom.current_turn_seat || 1;
  const isMyTurn = myPlayer && myPlayer.seat_number === activeSeat;

  const totalCost = prop.cost;
  const purchasePrice = gp?.purchase_price || totalCost;
  const marketValue = gp?.market_value || totalCost;
  const downPayment = (purchasePrice * 10) / 100;
  const roundMortgage = purchasePrice / 40;
  const canAfford = myPlayer && myPlayer.cash >= downPayment;
  const currentRound = currentRoom?.current_round || 1;
  const hasPurchasedThisRound = gameProperties.some(
    (g) => g.owner_user_id === currentUser?.id && g.purchased_round === currentRound
  );

  const installedImprovements = Array.isArray(gp?.improvements) ? gp.improvements : [];
  const isListed = !!gp?.is_listed;
  let statusBadgeHtml = '';
  if (!isBankOwned && !isOwnedByMe) {
    if (isListed) {
      statusBadgeHtml = `<div style="position: absolute; top: 1rem; right: 1rem; z-index: 2;"><span class="badge" style="background: rgba(2, 132, 199, 0.25); color: #38bdf8; border: 1px solid #0284c7; font-weight: 700; padding: 0.35rem 0.85rem; border-radius: 9999px;">FOR RESALE • ${formatMoney(gp.list_price)} (SEAT ${ownerPlayer?.seat_number || '?'})</span></div>`;
    } else {
      statusBadgeHtml = `<div style="position: absolute; top: 1rem; right: 1rem; z-index: 2;"><span class="badge" style="background: rgba(148, 163, 184, 0.15); color: #94a3b8; border: 1px solid #475569; font-weight: 700; padding: 0.35rem 0.85rem; border-radius: 9999px;">OWNED BY SEAT ${ownerPlayer?.seat_number || '?'} (${escapeHtml(ownerPlayer?.display_name || 'Player')})</span></div>`;
    }
  } else if (isOwnedByMe && isListed) {
    statusBadgeHtml = `<div style="position: absolute; top: 1rem; right: 1rem; z-index: 2;"><span class="badge" style="background: rgba(2, 132, 199, 0.25); color: #38bdf8; border: 1px solid #0284c7; font-weight: 700; padding: 0.35rem 0.85rem; border-radius: 9999px;">YOUR ACTIVE LISTING • ${formatMoney(gp.list_price)}</span></div>`;
  } else if (isBankOwned && installedImprovements.length > 0) {
    statusBadgeHtml = `<div style="position: absolute; top: 1rem; right: 1rem; z-index: 2;"><span class="badge" style="background: rgba(34, 197, 94, 0.2); color: #22c55e; border: 1px solid #16a34a; font-weight: 700; padding: 0.35rem 0.85rem; border-radius: 9999px;">UPGRADED (${installedImprovements.length} of 5)</span></div>`;
  }

  let actionHtml = '';
  if (isBankOwned) {
    if (isMyTurn) {
      if (hasPurchasedThisRound) {
        actionHtml = `
          <button class="btn-detail-buy" disabled title="You can only purchase 1 property per round">
            Purchase
          </button>
        `;
      } else if (canAfford) {
        actionHtml = `
          <button class="btn-detail-buy" id="btn-buy-property-detail" data-slug="${prop.slug}">
            Purchase
          </button>
        `;
      } else {
        actionHtml = `
          <button class="btn-detail-buy" disabled title="Insufficient cash (${formatMoney(myPlayer?.cash || 0)} / ${formatMoney(downPayment)})">
            Insufficient Cash
          </button>
        `;
      }
    } else {
      actionHtml = `
        <button class="btn-detail-buy" disabled>
          Wait Your Turn
        </button>
      `;
    }
  } else if (isOwnedByMe) {
    if (isListed) {
      actionHtml = `
        <button class="btn-detail-back" id="btn-detail-manage-listing" style="width: 100%; justify-content: center;">
          Manage Listing
        </button>
      `;
    } else {
      actionHtml = `
        <button class="btn-detail-buy" disabled>
          Purchased
        </button>
      `;
    }
  } else {
    actionHtml = `
      <div style="color: var(--text-muted); font-size: 0.85rem; text-align: center; width: 100%; display: flex; align-items: center; justify-content: center; line-height: 1.3;">
        Owned by <strong>&nbsp;${escapeHtml(ownerPlayer?.display_name || 'Opponent')}&nbsp;</strong> (Seat ${ownerPlayer?.seat_number || '?'})
      </div>
    `;
  }

  const detailCard = document.createElement('div');
  detailCard.className = 'property-detail-card';

  detailCard.innerHTML = `
    <div class="property-detail-stripe" style="background-color: ${prop.color_hex};"></div>
    <div class="property-detail-hero">
      ${statusBadgeHtml}
      <div class="property-hero-graphic" style="position: absolute; inset: 0; z-index: 1;">
        ${getPropertySvgPlaceholder(prop.color_hex)}
      </div>
    </div>
    <div class="property-detail-body">
      <div class="property-detail-header-row">
        <div class="property-detail-title-group">
          <h3 style="margin: 0;">${escapeHtml(prop.name)}</h3>
        </div>
      </div>

      <div class="property-detail-grid">
        <div class="property-detail-stat">
          <span class="property-detail-stat-label">${isListed ? 'Asking List Price' : 'Market Value'}</span>
          <span class="property-detail-stat-val" style="color: #22c55e;">
            ${formatMoney(isListed ? gp.list_price : marketValue)}
            ${!isListed && marketValue > totalCost ? `<span style="font-size: 0.8rem; font-weight: 600; opacity: 0.9; margin-left: 4px;">(+${Math.round(((marketValue - totalCost) / totalCost) * 100)}%)</span>` : ''}
          </span>
        </div>
        <div class="property-detail-stat">
          <span class="property-detail-stat-label">${isBankOwned ? 'Purchase Price (Bank)' : (isListed ? 'Market Appraisal' : 'Purchase Price')}</span>
          <span class="property-detail-stat-val ${isBankOwned ? 'accent' : ''}">${formatMoney(isBankOwned ? totalCost : (isListed ? marketValue : purchasePrice))}</span>
        </div>
        <div class="property-detail-stat">
          <span class="property-detail-stat-label">Mortgage / Round</span>
          <span class="property-detail-stat-val" style="color: #38bdf8;">${formatMoney(roundMortgage)}</span>
        </div>
        <div class="property-detail-stat">
          <span class="property-detail-stat-label">Layout & Size</span>
          <span class="property-detail-stat-val" style="font-size: 1.1rem; padding-top: 0.2rem;">
            ${prop.beds} bds • ${prop.baths} ba • ${prop.sqft.toLocaleString()} sqft
          </span>
        </div>
      </div>
    </div>

    ${installedImprovements.length > 0 ? `
      <div class="improvements-section" style="padding: 1.25rem 2rem; background: rgba(15, 23, 42, 0.3); border-top: 1px solid var(--border-color);">
        <div class="improvements-header" style="margin-bottom: 0.65rem;">
          <h4 style="font-size: 1rem; margin: 0;">🔨 Included Improvements (${installedImprovements.length} of 5)</h4>
        </div>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
          ${installedImprovements.map((k) => {
            const cat = IMPROVEMENTS_CATALOG.find((c) => c.key === k);
            return `<span class="badge-installed">${cat ? cat.icon + ' ' + escapeHtml(cat.name) : k}</span>`;
          }).join('')}
        </div>
      </div>
    ` : ''}

    <div class="property-detail-actions">
      <button class="btn-detail-back" id="btn-detail-back-bottom" style="flex: 1; min-width: 0;">
        Keep Browsing
      </button>
      <div style="flex: 1; min-width: 0; display: flex;">
        ${actionHtml}
      </div>
    </div>
  `;

  // Hook action buttons
  const backBottomBtn = detailCard.querySelector('#btn-detail-back-bottom');
  if (backBottomBtn) {
    backBottomBtn.addEventListener('click', () => showGameSubpage('buy-properties'));
  }

  const manageListingBtn = detailCard.querySelector('#btn-detail-manage-listing');
  if (manageListingBtn) {
    manageListingBtn.addEventListener('click', () => showGameSubpage('sell-properties'));
  }

  const gotoPaymentsBtn = detailCard.querySelector('#btn-detail-goto-payments');
  if (gotoPaymentsBtn) {
    gotoPaymentsBtn.addEventListener('click', () => showGameSubpage('make-payments'));
  }

  const buyDetailBtn = detailCard.querySelector('#btn-buy-property-detail');
  if (buyDetailBtn) {
    buyDetailBtn.addEventListener('click', () => {
      openPurchaseModal(prop);
    });
  }

  propertyDetailsContainer.appendChild(detailCard);
}

// Purchase Confirmation Modal Logic
function openPurchaseModal(prop) {
  if (!prop || !currentRoom) return;
  pendingPurchaseProperty = prop;

  const gp = gameProperties.find((g) => g.property_slug === prop.slug);
  const myPlayer = currentPlayers.find((p) => p.user_id === currentUser?.id);
  const totalCost = prop.cost;
  const purchasePrice = gp?.purchase_price || totalCost;
  const marketValue = gp?.market_value || totalCost;
  const downPayment = (purchasePrice * 10) / 100;
  const roundMortgage = purchasePrice / 40;
  const remainingCash = (myPlayer?.cash || 0) - downPayment;

  if (modalPropertyName) modalPropertyName.textContent = prop.name;
  if (modalPropTotalCost) modalPropTotalCost.textContent = formatMoney(totalCost);
  if (modalPropDownPayment) modalPropDownPayment.textContent = formatMoney(downPayment);
  if (modalPropMortgage) modalPropMortgage.textContent = `${formatMoney(roundMortgage)} / rd`;
  if (modalPropRemainingCash) modalPropRemainingCash.textContent = formatMoney(remainingCash);

  if (btnConfirmPurchase) {
    btnConfirmPurchase.disabled = false;
    btnConfirmPurchase.textContent = 'Confirm Purchase';
  }

  if (purchaseConfirmModal) {
    purchaseConfirmModal.classList.remove('hidden');
  }
}

function closePurchaseModal() {
  if (purchaseConfirmModal) {
    purchaseConfirmModal.classList.add('hidden');
  }
  pendingPurchaseProperty = null;
}

if (btnCancelPurchase) {
  btnCancelPurchase.addEventListener('click', closePurchaseModal);
}

if (purchaseConfirmModal) {
  purchaseConfirmModal.addEventListener('click', (e) => {
    if (e.target === purchaseConfirmModal) closePurchaseModal();
  });
}

if (btnConfirmPurchase) {
  btnConfirmPurchase.addEventListener('click', async () => {
    if (!pendingPurchaseProperty || !currentRoom) return;
    const propToBuy = pendingPurchaseProperty;
    const downPayment = (propToBuy.cost * 10) / 100;

    btnConfirmPurchase.disabled = true;
    btnConfirmPurchase.textContent = 'Purchasing...';

    try {
      await buyProperty(currentRoom.id, propToBuy.slug);
      closePurchaseModal();

      const { room, players, gameProperties: updatedProps } = await fetchGameData(currentRoom.id);
      currentRoom = room;
      currentPlayers = players;
      gameProperties = updatedProps;

      renderGameHUD();
      renderProperties();
      renderPropertyDetails(propToBuy.slug);
    } catch (err) {
      showAlert(err.message || 'Failed to purchase property.');
      btnConfirmPurchase.disabled = false;
      btnConfirmPurchase.textContent = 'Confirm Purchase';
    }
  });
}

// Render Sell Properties (Portfolio Feed)
function renderSellProperties() {
  if (!sellPropertiesContainer) return;
  sellPropertiesContainer.innerHTML = '';

  const myPlayer = currentPlayers.find((p) => p.user_id === currentUser?.id);
  const activeSeat = currentRoom?.current_turn_seat || 1;
  const isMyTurn = myPlayer && myPlayer.seat_number === activeSeat;
  const currentRound = currentRoom?.current_round || 1;

  const myProperties = gameProperties.filter((gp) => gp.owner_user_id === currentUser?.id);

  if (myProperties.length === 0) {
    sellPropertiesContainer.innerHTML = `
      <div class="card placeholder-card" style="padding: 4rem 2rem;">
        <div style="font-size: 3rem; margin-bottom: 1rem;">🏷️</div>
        <h3 style="margin-bottom: 0.5rem; font-size: 1.35rem;">No Properties in Portfolio</h3>
        <p style="color: var(--text-muted); max-width: 460px; margin: 0 auto 1.5rem auto; line-height: 1.5;">
          You don't own any properties yet. Head over to <strong>Buy Properties</strong> on your turn to finance your first real estate deed with 10% down!
        </p>
        <button class="btn btn-primary" id="btn-goto-buy-from-sell" style="padding: 0.65rem 1.5rem;">
          Browse Properties
        </button>
      </div>
    `;
    const gotoBtn = document.getElementById('btn-goto-buy-from-sell');
    if (gotoBtn) gotoBtn.addEventListener('click', () => showGameSubpage('buy-properties'));
    return;
  }

  myProperties.forEach((gp) => {
    const prop = catalogProperties.find((cp) => cp.slug === gp.property_slug);
    if (!prop) return;

    const totalCost = prop.cost;
    const purchasePrice = gp.purchase_price || totalCost;
    const marketValue = gp.market_value || purchasePrice;
    const downPayment = (purchasePrice * 10) / 100;
    const roundMortgage = purchasePrice / 40;
    const isPurchasedThisRound = gp.purchased_round === currentRound;
    const isImprovedThisRound = gp.last_improved_round === currentRound;
    const isListed = !!gp.is_listed;

    let actionBtnHtml = '';
    if (isListed) {
      if (isMyTurn) {
        actionBtnHtml = `
          <div style="display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap;">
            <button class="btn btn-secondary btn-delist-property" data-slug="${prop.slug}" style="padding: 0.85rem 1.5rem; font-weight: 700; border-radius: 8px;">
              Delist Property
            </button>
            <button class="btn-detail-buy btn-open-list-modal" data-slug="${prop.slug}">
              Update Asking Price
            </button>
          </div>
        `;
      } else {
        actionBtnHtml = `<button class="btn-detail-buy" disabled>Listed for ${formatMoney(gp.list_price)}</button>`;
      }
    } else {
      if (isMyTurn) {
        if (isPurchasedThisRound) {
          actionBtnHtml = `
            <button class="btn-detail-buy" disabled title="You cannot buy and list the same property in the same round (Eligible Round ${currentRound + 1})">
              List Property
            </button>
          `;
        } else if (isImprovedThisRound) {
          actionBtnHtml = `
            <button class="btn-detail-buy" disabled title="You cannot make improvements and list the same property in the same round (Eligible Round ${currentRound + 1})">
              List Property
            </button>
          `;
        } else {
          actionBtnHtml = `
            <button class="btn-detail-buy btn-open-list-modal" data-slug="${prop.slug}">
              List Property
            </button>
          `;
        }
      } else {
        actionBtnHtml = `<button class="btn-detail-buy" disabled>Wait Your Turn</button>`;
      }
    }

    const card = document.createElement('div');
    card.className = 'property-detail-card';

    card.innerHTML = `
      <div class="property-detail-stripe" style="background-color: ${prop.color_hex};"></div>
      <div class="property-detail-hero">
        <div class="property-hero-graphic" style="position: absolute; inset: 0; z-index: 1;">
          ${getPropertySvgPlaceholder(prop.color_hex)}
        </div>
      </div>
      <div class="property-detail-body">
        <div class="property-detail-header-row">
          <div class="property-detail-title-group">
            <h3 style="margin: 0;">${escapeHtml(prop.name)}</h3>
          </div>
        </div>

        <div class="property-detail-grid">
          <div class="property-detail-stat">
            <span class="property-detail-stat-label">Asking Price</span>
            <span class="property-detail-stat-val" style="${isListed ? 'color: #38bdf8; font-weight: 800;' : 'color: var(--text-muted);'}">
              ${isListed ? formatMoney(gp.list_price) : 'Not Listed'}
            </span>
          </div>
          <div class="property-detail-stat">
            <span class="property-detail-stat-label">Market Value</span>
            <span class="property-detail-stat-val" style="color: #22c55e;">${formatMoney(marketValue)}</span>
          </div>
          <div class="property-detail-stat">
            <span class="property-detail-stat-label">Purchase Price</span>
            <span class="property-detail-stat-val">${formatMoney(purchasePrice)}</span>
          </div>
          <div class="property-detail-stat">
            <span class="property-detail-stat-label">Mortgage / Round</span>
            <span class="property-detail-stat-val" style="color: #38bdf8;">${formatMoney(roundMortgage)}</span>
          </div>
          <div class="property-detail-stat">
            <span class="property-detail-stat-label">Layout & Size</span>
            <span class="property-detail-stat-val" style="font-size: 1.1rem; padding-top: 0.2rem;">
              ${prop.beds} bds • ${prop.baths} ba • ${prop.sqft.toLocaleString()} sqft
            </span>
          </div>
        </div>
      </div>

      <div class="property-detail-actions" style="justify-content: flex-end;">
        <div>
          ${actionBtnHtml}
        </div>
      </div>
    `;

    const openListBtn = card.querySelector('.btn-open-list-modal');
    if (openListBtn) {
      openListBtn.addEventListener('click', () => {
        openListModal(prop, gp);
      });
    }

    const delistBtn = card.querySelector('.btn-delist-property');
    if (delistBtn) {
      delistBtn.addEventListener('click', async () => {
        delistBtn.disabled = true;
        delistBtn.textContent = 'Delisting...';
        try {
          await delistProperty(currentRoom.id, prop.slug);
          const { room, players, gameProperties: updatedProps } = await fetchGameData(currentRoom.id);
          currentRoom = room;
          currentPlayers = players;
          gameProperties = updatedProps;
          renderGameHUD();
          renderProperties();
          renderSellProperties();
        } catch (err) {
          showAlert(err.message || 'Failed to delist property.');
          delistBtn.disabled = false;
          delistBtn.textContent = 'Delist Property';
        }
      });
    }

    sellPropertiesContainer.appendChild(card);
  });
}

// List Property Modal Logic
function openListModal(prop, gp) {
  if (!prop || !currentRoom) return;
  pendingListProperty = prop;

  const marketVal = gp?.market_value || prop.cost;
  if (modalListPropertyName) modalListPropertyName.textContent = prop.name;
  if (modalListPropertyBaseCost) modalListPropertyBaseCost.textContent = formatMoney(marketVal);
  if (modalListPriceInput) {
    modalListPriceInput.value = gp?.list_price || marketVal;
    setTimeout(() => {
      modalListPriceInput.focus();
      modalListPriceInput.select();
    }, 50);
  }

  if (btnConfirmListProperty) {
    btnConfirmListProperty.disabled = false;
    btnConfirmListProperty.textContent = gp?.is_listed ? 'Update Asking Price' : 'List for Sale';
  }

  if (listPropertyModal) {
    listPropertyModal.classList.remove('hidden');
  }
}

function closeListModal() {
  if (listPropertyModal) listPropertyModal.classList.add('hidden');
  pendingListProperty = null;
}

if (btnCancelListProperty) {
  btnCancelListProperty.addEventListener('click', closeListModal);
}

if (listPropertyModal) {
  listPropertyModal.addEventListener('click', (e) => {
    if (e.target === listPropertyModal) closeListModal();
  });
}

if (btnConfirmListProperty) {
  btnConfirmListProperty.addEventListener('click', async () => {
    if (!pendingListProperty || !currentRoom) return;
    const askingPrice = parseInt(modalListPriceInput.value, 10);
    if (!askingPrice || askingPrice <= 0 || askingPrice > 10000000) {
      showAlert('Please enter a valid asking price between $1 and $10,000,000.');
      modalListPriceInput.focus();
      return;
    }

    btnConfirmListProperty.disabled = true;
    btnConfirmListProperty.textContent = 'Listing...';

    try {
      await listProperty(currentRoom.id, pendingListProperty.slug, askingPrice);
      closeListModal();

      const { room, players, gameProperties: updatedProps } = await fetchGameData(currentRoom.id);
      currentRoom = room;
      currentPlayers = players;
      gameProperties = updatedProps;

      renderGameHUD();
      renderProperties();
      renderSellProperties();
    } catch (err) {
      showAlert(err.message || 'Failed to list property.');
      btnConfirmListProperty.disabled = false;
      btnConfirmListProperty.textContent = 'List for Sale';
    }
  });
}

// Render Make Improvements View
function renderMakeImprovements() {
  if (!makeImprovementsContainer) return;
  makeImprovementsContainer.innerHTML = '';

  const myPlayer = currentPlayers.find((p) => p.user_id === currentUser?.id);
  const activeSeat = currentRoom?.current_turn_seat || 1;
  const isMyTurn = myPlayer && myPlayer.seat_number === activeSeat;
  const currentRound = currentRoom?.current_round || 1;

  // Filter owned properties
  const myProperties = gameProperties.filter((gp) => gp.owner_user_id === currentUser?.id);

  if (myProperties.length === 0) {
    makeImprovementsContainer.innerHTML = `
      <div class="card placeholder-card">
        <div style="font-size: 3rem; margin-bottom: 1rem;">🔨</div>
        <h3 style="margin-bottom: 0.5rem; font-size: 1.35rem;">No Properties to Renovate</h3>
        <p style="color: var(--text-muted); max-width: 460px; margin: 0 auto 1.5rem auto; line-height: 1.5;">
          You don't own any properties yet. Head over to <strong>Buy Properties</strong> on your turn to finance a deed, then return in subsequent rounds to upgrade and boost its market value!
        </p>
        <button class="btn btn-primary" id="btn-improve-goto-buy" style="padding: 0.65rem 1.5rem;">
          Browse Properties
        </button>
      </div>
    `;
    const gotoBtn = document.getElementById('btn-improve-goto-buy');
    if (gotoBtn) gotoBtn.addEventListener('click', () => showGameSubpage('buy-properties'));
    return;
  }

  myProperties.forEach((gp) => {
    const prop = catalogProperties.find((cp) => cp.slug === gp.property_slug);
    if (!prop) return;

    const purchasePrice = gp.purchase_price || prop.cost;
    const marketValue = gp.market_value || purchasePrice;
    const roundMortgage = purchasePrice / 40;
    const isPurchasedThisRound = gp.purchased_round === currentRound;
    const isListed = !!gp.is_listed;
    const isListedThisRound = isListed || (gp.listed_round === currentRound);
    const installedImprovements = Array.isArray(gp.improvements) ? gp.improvements : [];
    const isFullyUpgraded = installedImprovements.length === 5;
    const totalBoost = marketValue - purchasePrice;

    let actionBtnHtml = '';
    if (isFullyUpgraded) {
      actionBtnHtml = `
        <button class="btn-detail-buy" disabled style="background: rgba(34, 197, 94, 0.2); color: #22c55e; border: 1px solid #16a34a;">
          Max Upgraded (5/5)
        </button>
      `;
    } else if (!isMyTurn) {
      actionBtnHtml = `<button class="btn-detail-buy" disabled>Wait Your Turn</button>`;
    } else if (isPurchasedThisRound) {
      actionBtnHtml = `
        <button class="btn-detail-buy" disabled title="Cannot make improvements in the same round the property was purchased (Eligible Round ${currentRound + 1})">
          Improve Property
        </button>
      `;
    } else if (isListed) {
      actionBtnHtml = `
        <button class="btn-detail-buy" disabled title="Cannot make improvements while property is actively listed for sale">
          Improve Property
        </button>
      `;
    } else if (isListedThisRound) {
      actionBtnHtml = `
        <button class="btn-detail-buy" disabled title="Cannot list and improve a property in the same round (Eligible Round ${currentRound + 1})">
          Improve Property
        </button>
      `;
    } else {
      actionBtnHtml = `
        <button class="btn-detail-buy btn-open-improve-modal" data-slug="${prop.slug}">
          Improve Property
        </button>
      `;
    }

    const card = document.createElement('div');
    card.className = 'property-detail-card';

    card.innerHTML = `
      <div class="property-detail-stripe" style="background-color: ${prop.color_hex};"></div>
      <div class="property-detail-hero">
        <div class="property-hero-graphic" style="position: absolute; inset: 0; z-index: 1;">
          ${getPropertySvgPlaceholder(prop.color_hex)}
        </div>
      </div>
      <div class="property-detail-body">
        <div class="property-detail-header-row">
          <div class="property-detail-title-group">
            <h3 style="margin: 0;">${escapeHtml(prop.name)}</h3>
          </div>
          ${isFullyUpgraded ? '<span class="badge" style="background: rgba(34, 197, 94, 0.2); color: #22c55e; border: 1px solid #16a34a; font-weight: 700; padding: 0.35rem 0.85rem; border-radius: 9999px;">MAX UPGRADED (2X)</span>' : ''}
        </div>

        <div class="property-detail-grid">
          <div class="property-detail-stat">
            <span class="property-detail-stat-label">Market Value</span>
            <span class="property-detail-stat-val" style="color: #22c55e;">
              ${formatMoney(marketValue)}
              ${totalBoost > 0 ? `<span style="font-size: 0.8rem; font-weight: 600; opacity: 0.9; margin-left: 4px;">(+${Math.round((totalBoost / purchasePrice) * 100)}%)</span>` : ''}
            </span>
          </div>
          <div class="property-detail-stat">
            <span class="property-detail-stat-label">Purchase Price</span>
            <span class="property-detail-stat-val">${formatMoney(purchasePrice)}</span>
          </div>
          <div class="property-detail-stat">
            <span class="property-detail-stat-label">Improvements</span>
            <span class="property-detail-stat-val" style="color: #38bdf8;">${installedImprovements.length} of 5</span>
          </div>
          <div class="property-detail-stat">
            <span class="property-detail-stat-label">Mortgage / Round</span>
            <span class="property-detail-stat-val" style="color: #38bdf8;">${formatMoney(roundMortgage)}</span>
          </div>
          <div class="property-detail-stat">
            <span class="property-detail-stat-label">Layout & Size</span>
            <span class="property-detail-stat-val" style="font-size: 1.1rem; padding-top: 0.2rem;">
              ${prop.beds} bds • ${prop.baths} ba • ${prop.sqft.toLocaleString()} sqft
            </span>
          </div>
        </div>
      </div>

      <div class="property-detail-actions" style="justify-content: flex-end;">
        <div>
          ${actionBtnHtml}
        </div>
      </div>
    `;

    // Hook Improve Property button
    const openImproveBtn = card.querySelector('.btn-open-improve-modal');
    if (openImproveBtn) {
      openImproveBtn.addEventListener('click', () => {
        openImproveModal(prop, gp);
      });
    }

    makeImprovementsContainer.appendChild(card);
  });
}

// Improve Property Modal Logic
function openImproveModal(prop, gp) {
  if (!prop || !currentRoom) return;
  pendingImproveProperty = prop;
  renderImproveModalContent();
  if (improvePropertyModal) {
    improvePropertyModal.classList.remove('hidden');
  }
}

function closeImproveModal() {
  if (improvePropertyModal) {
    improvePropertyModal.classList.add('hidden');
  }
  pendingImproveProperty = null;
}

function renderImproveModalContent() {
  if (!pendingImproveProperty || !improvePropertyModal) return;
  const prop = pendingImproveProperty;
  const gp = gameProperties.find((g) => g.property_slug === prop.slug);
  if (!gp) return;

  const myPlayer = currentPlayers.find((p) => p.user_id === currentUser?.id);
  const purchasePrice = gp.purchase_price || prop.cost;
  const marketValue = gp.market_value || purchasePrice;
  const installedImprovements = Array.isArray(gp.improvements) ? gp.improvements : [];
  const playerCash = myPlayer?.cash || 0;

  if (modalImprovePropertyName) modalImprovePropertyName.textContent = prop.name;
  if (modalImproveProgress) modalImproveProgress.textContent = `${installedImprovements.length} of 5 Completed`;
  if (modalImproveMarketValue) modalImproveMarketValue.textContent = formatMoney(marketValue);
  if (modalImprovePurchasePrice) modalImprovePurchasePrice.textContent = formatMoney(purchasePrice);
  if (modalImprovePlayerCash) modalImprovePlayerCash.textContent = formatMoney(playerCash);

  if (!modalImprovementsList) return;
  modalImprovementsList.innerHTML = '';

  IMPROVEMENTS_CATALOG.forEach((imp) => {
    const isInstalled = installedImprovements.includes(imp.key);
    const impCost = (purchasePrice * 10) / 100;
    const impBoost = (purchasePrice * 20) / 100;
    const canAfford = playerCash >= impCost;

    let actionBtnHtml = '';
    if (isInstalled) {
      actionBtnHtml = `<span class="badge-installed">✓ INSTALLED</span>`;
    } else if (!canAfford) {
      actionBtnHtml = `
        <button class="btn-install-improvement" disabled title="Insufficient cash (${formatMoney(playerCash)} available)">
          Install (${formatMoney(impCost)})
        </button>
      `;
    } else {
      actionBtnHtml = `
        <button class="btn-install-improvement btn-modal-install" data-slug="${prop.slug}" data-key="${imp.key}">
          Install (${formatMoney(impCost)})
        </button>
      `;
    }

    const itemDiv = document.createElement('div');
    itemDiv.className = `improvement-item ${isInstalled ? 'is-installed' : ''}`;
    itemDiv.innerHTML = `
      <div class="improvement-info">
        <div class="improvement-title">
          <span>${imp.icon}</span>
          <span>${escapeHtml(imp.name)}</span>
        </div>
        <div class="improvement-meta">
          <span>Cost: <span class="improvement-cost-val">${formatMoney(impCost)}</span></span>
          <span>Boost: <span class="improvement-boost-val">+${formatMoney(impBoost)} Market Value</span></span>
        </div>
      </div>
      <div>
        ${actionBtnHtml}
      </div>
    `;

    const installBtn = itemDiv.querySelector('.btn-modal-install');
    if (installBtn) {
      installBtn.addEventListener('click', async () => {
        installBtn.disabled = true;
        installBtn.textContent = 'Installing...';
        try {
          await makeImprovement(currentRoom.id, prop.slug, imp.key);
          const { room, players, gameProperties: updatedProps } = await fetchGameData(currentRoom.id);
          currentRoom = room;
          currentPlayers = players;
          gameProperties = updatedProps;

          renderGameHUD();
          renderProperties();
          renderMakeImprovements();
          renderImproveModalContent();
        } catch (err) {
          showAlert(err.message || 'Failed to install improvement.');
          renderImproveModalContent();
        }
      });
    }

    modalImprovementsList.appendChild(itemDiv);
  });
}

if (btnCloseImproveModal) {
  btnCloseImproveModal.addEventListener('click', closeImproveModal);
}

if (improvePropertyModal) {
  improvePropertyModal.addEventListener('click', (e) => {
    if (e.target === improvePropertyModal) closeImproveModal();
  });
}

// Render Mortgage & Make Payments List
function renderMortgagePayments() {
  if (!mortgagePaymentsContainer) return;
  mortgagePaymentsContainer.innerHTML = '';

  const myPlayer = currentPlayers.find((p) => p.user_id === currentUser?.id);
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
    const isPaidThisRound = (gp.last_paid_round || 0) >= currentRound;

    const card = document.createElement('div');
    card.className = `mortgage-card ${isDelinquent ? 'is-delinquent' : ''}`;

    let statusBadge = '';
    let warningBox = '';
    let actionBtnHtml = '';

    if (isPaidThisRound) {
      if (isDelinquent) {
        statusBadge = `<span class="badge badge-delinquent-paid">ROUND ${currentRound} PAID • DELINQUENT</span>`;
        warningBox = `
          <div class="mortgage-warning-box">
            <strong>⚠️ Protected for Round ${currentRound}:</strong> You made a single payment to stave off foreclosure for this round. However, you are still 1 payment in arrears. Next round, you may make another single payment or pay double to clear the delinquency.
          </div>
        `;
        actionBtnHtml = `<button class="btn-pay-mortgage" disabled>Protected for Round ${currentRound}</button>`;
      } else {
        statusBadge = `<span class="badge badge-paid">PAID FOR ROUND ${currentRound} ✓</span>`;
        actionBtnHtml = `<button class="btn-pay-mortgage" disabled>Paid for Round ${currentRound}</button>`;
      }
    } else if (isDelinquent) {
      statusBadge = `<span class="badge badge-delinquent">⚠️ DELINQUENT • 1 MISSED</span>`;
      warningBox = `
        <div class="mortgage-warning-box">
          <strong>⚠️ Foreclosure Warning:</strong> You missed payment last round. Choose an option: pay <strong>single (${formatMoney(basePayment)})</strong> to stave off foreclosure this round while remaining delinquent, or pay <strong>double (${formatMoney(basePayment * 2)})</strong> to bring your mortgage completely current.
        </div>
      `;
      if (isMyTurn) {
        actionBtnHtml = `
          <div class="actions-delinquent-row" style="display: flex; gap: 0.5rem; width: 100%;">
            <button class="btn-pay-mortgage btn-pay-single-delinquent" data-slug="${catalog.slug}" data-double="false" style="flex: 1; min-width: 0; padding: 0.65rem 0.35rem; font-size: 0.82rem;">
              Pay Single (${formatMoney(basePayment)})
              <span style="display: block; font-size: 0.72rem; opacity: 0.9; margin-top: 2px;">Stave Off</span>
            </button>
            <button class="btn-pay-mortgage btn-pay-double-delinquent" data-slug="${catalog.slug}" data-double="true" style="flex: 1; min-width: 0; padding: 0.65rem 0.35rem; font-size: 0.82rem;">
              Pay Double (${formatMoney(basePayment * 2)})
              <span style="display: block; font-size: 0.72rem; opacity: 0.9; margin-top: 2px;">Bring Current</span>
            </button>
          </div>
        `;
      } else {
        actionBtnHtml = `<button class="btn-pay-mortgage" disabled>Wait Your Turn</button>`;
      }
    } else {
      statusBadge = `<span class="badge badge-due">DUE ROUND ${currentRound}</span>`;
      if (isMyTurn) {
        actionBtnHtml = `<button class="btn-pay-mortgage" data-slug="${catalog.slug}" data-double="false">Pay Mortgage (${formatMoney(basePayment)})</button>`;
      } else {
        actionBtnHtml = `<button class="btn-pay-mortgage" disabled>Wait Your Turn</button>`;
      }
    }

    card.innerHTML = `
      <div class="card-color-stripe" style="background-color: ${catalog.color_hex};"></div>
      <div class="mortgage-card-header">
        <div>
          <h3 style="font-size: 1.25rem; font-weight: 700;">${escapeHtml(catalog.name)}</h3>
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
          <span class="mortgage-stat-label">Status</span>
          <span class="mortgage-stat-val" style="color: ${isDelinquent ? '#f59e0b' : '#22c55e'}; font-size: 0.95rem;">
            ${isPaidThisRound ? (isDelinquent ? 'Delinquent (Paid Rd)' : 'Current (Paid)') : (isDelinquent ? '1 Missed Payment' : 'Payment Due')}
          </span>
        </div>
      </div>
      ${warningBox}
      <div class="mortgage-card-footer">
        ${actionBtnHtml}
      </div>
    `;

    // Hook payment buttons
    const payBtns = card.querySelectorAll('.btn-pay-mortgage:not(:disabled)');
    payBtns.forEach((payBtn) => {
      payBtn.addEventListener('click', async () => {
        const isDouble = payBtn.dataset.double === 'true';
        const paymentAmount = isDouble ? basePayment * 2 : basePayment;

        payBtns.forEach((b) => {
          b.disabled = true;
        });
        payBtn.textContent = 'Processing...';

        try {
          await makeMortgagePayment(currentRoom.id, catalog.slug, isDouble);
          const { room, players, gameProperties: updatedProps } = await fetchGameData(currentRoom.id);
          currentRoom = room;
          currentPlayers = players;
          gameProperties = updatedProps;
          renderGameHUD();
          renderMortgagePayments();
          renderProperties();
        } catch (err) {
          showAlert(err.message || 'Failed to make mortgage payment.');
          payBtns.forEach((b) => {
            b.disabled = false;
          });
          renderMortgagePayments();
        }
      });
    });

    mortgagePaymentsContainer.appendChild(card);
  });
}

// --- Financial Report (Balance Sheet) ---
function renderFinancialReport() {
  if (!financialReportContainer) return;

  const myPlayer = currentPlayers.find((p) => p.user_id === currentUser?.id);
  const cash = myPlayer ? myPlayer.cash : 0;
  const myProperties = gameProperties.filter((gp) => gp.owner_user_id === currentUser?.id);

  // Build one line item per owned property
  const items = myProperties
    .map((gp) => {
      const prop = catalogProperties.find((cp) => cp.slug === gp.property_slug);
      if (!prop) return null;
      const purchasePrice = gp.purchase_price || prop.cost;
      const marketValue = gp.market_value || purchasePrice;
      const mortgageBalance = Math.max(0, gp.mortgage_balance || 0);
      // Each missed payment is one 1/40th installment; it is part of the balance owed
      const pastDue = Math.min(mortgageBalance, (gp.missed_payments || 0) * Math.floor(prop.cost / 40));
      return {
        name: prop.name,
        color: prop.color_hex,
        marketValue,
        mortgageBalance,
        pastDue,
        current: mortgageBalance - pastDue
      };
    })
    .filter(Boolean);

  const totalFixedAssets = items.reduce((sum, i) => sum + i.marketValue, 0);
  const totalAssets = cash + totalFixedAssets;
  const totalMortgages = items.reduce((sum, i) => sum + i.current, 0);
  const totalPastDue = items.reduce((sum, i) => sum + i.pastDue, 0);
  const totalLiabilities = totalMortgages + totalPastDue;
  const equity = totalAssets - totalLiabilities;

  const row = (label, amount, { dot, cls = '', amountCls = '' } = {}) => `
    <div class="bs-row ${cls}">
      <span class="bs-row-label">
        ${dot ? `<span class="bs-dot" style="background-color: ${dot};"></span>` : ''}
        <span class="bs-row-label-text">${label}</span>
      </span>
      <span class="bs-amount ${amountCls}">${amount}</span>
    </div>`;

  const fixedAssetRows = items.length
    ? items.map((i) => row(escapeHtml(i.name), formatMoney(i.marketValue), { dot: i.color })).join('')
    : row('No property assets owned yet', formatMoney(0), { cls: 'bs-muted' });

  const mortgageRows = items.filter((i) => i.current > 0)
    .map((i) => row(escapeHtml(i.name), formatMoney(i.current), { dot: i.color })).join('');
  const pastDueRows = items.filter((i) => i.pastDue > 0)
    .map((i) => row(escapeHtml(i.name), formatMoney(i.pastDue), { dot: i.color })).join('');

  financialReportContainer.innerHTML = `
    <div class="financial-balance-card">
      <div class="financial-balance-label">Bank Account Balance</div>
      <div class="financial-balance-val">${formatMoney(cash)}</div>
    </div>
    <div class="balance-sheet">
      <div class="bs-title-bar">
        <h3 class="bs-title">Balance Sheet</h3>
      </div>

      <div class="bs-section">
        <div class="bs-section-title">Assets</div>
        <div class="bs-group-title">Current Assets</div>
        ${row('Cash (bank account)', formatMoney(cash))}
        <div class="bs-group-title">Fixed Assets</div>
        ${fixedAssetRows}
        ${row('Total Fixed Assets', formatMoney(totalFixedAssets), { cls: 'bs-subtotal' })}
        ${row('Total Assets', formatMoney(totalAssets), { cls: 'bs-total', amountCls: 'is-positive' })}
      </div>

      <div class="bs-section">
        <div class="bs-section-title">Liabilities</div>
        <div class="bs-group-title">Mortgages Payable</div>
        ${mortgageRows || row('None', formatMoney(0), { cls: 'bs-muted' })}
        <div class="bs-group-title">Past-Due Payments</div>
        ${pastDueRows || row('None', formatMoney(0), { cls: 'bs-muted' })}
        ${row('Total Liabilities', formatMoney(totalLiabilities), { cls: 'bs-total', amountCls: totalLiabilities > 0 ? 'is-negative' : '' })}
      </div>

      <div class="bs-section" style="border-bottom: none; padding-bottom: 0;">
        <div class="bs-section-title bs-equity-title">Equity</div>
        ${row('Owner Equity (Assets - Liabilities)', formatMoney(equity), { cls: 'bs-total bs-equity-row', amountCls: equity >= 0 ? 'is-positive' : 'is-negative' })}
      </div>
    </div>
  `;
}

// --- Market Report View ---
function renderMarketReport() {
  if (!marketReportContainer) return;

  const temperature = currentRoom?.market_temperature || 'Comfy';
  let tempClass = 'temp-comfy';
  if (temperature === 'Ice Cold') tempClass = 'temp-ice-cold';
  else if (temperature === 'Chilly') tempClass = 'temp-chilly';
  else if (temperature === 'Comfy') tempClass = 'temp-comfy';
  else if (temperature === 'Toasty') tempClass = 'temp-toasty';
  else if (temperature === 'On Fire') tempClass = 'temp-on-fire';

  // 1. Market Temperature Card (Clean metric card, no icons, no selling odds)
  const tempCardHtml = `
    <div class="market-temperature-card">
      <div class="market-temperature-label">Market Temperature</div>
      <div class="market-temperature-val ${tempClass}">${escapeHtml(temperature)}</div>
    </div>
  `;

  // 2. Sales History Section: Show all properties purchased, price, and round
  const purchasedProperties = gameProperties
    .filter((gp) => gp.purchased_round != null)
    .sort((a, b) => (b.purchased_round || 0) - (a.purchased_round || 0));

  let salesHistoryHtml = '';
  if (purchasedProperties.length === 0) {
    salesHistoryHtml = `
      <div class="sales-history-section">
        <h3 class="sales-history-title">Sales History (0)</h3>
        <div class="card placeholder-card" style="padding: 3rem 1.5rem;">
          <h4 style="margin-bottom: 0.5rem; font-size: 1.25rem;">No Purchases Yet</h4>
          <p style="color: var(--text-muted); max-width: 440px; margin: 0 auto; line-height: 1.5; font-size: 0.95rem;">
            No properties have been purchased yet this game. When properties are purchased from the bank or marketplace, each transaction, price, and round will appear here.
          </p>
        </div>
      </div>
    `;
  } else {
    const itemsHtml = purchasedProperties.map((gp) => {
      const prop = catalogProperties.find((cp) => cp.slug === gp.property_slug);
      if (!prop) return '';

      const buyer = currentPlayers.find((p) => p.user_id === gp.owner_user_id);
      const buyerName = buyer ? buyer.display_name : 'Player';
      const price = gp.purchase_price || prop.cost;

      return `
        <div class="sales-history-item">
          <div class="sales-history-stripe" style="background-color: ${prop.color_hex};"></div>
          <div class="sales-history-content">
            <div class="sales-history-prop-group">
              <span class="sales-history-prop-name">${escapeHtml(prop.name)}</span>
              <div class="sales-history-meta">
                <span>Buyer: ${escapeHtml(buyerName)}</span>
              </div>
            </div>
            <div class="sales-history-price-group">
              <span class="sales-history-price">${formatMoney(price)}</span>
              <span class="sales-history-badge">Round ${gp.purchased_round}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    salesHistoryHtml = `
      <div class="sales-history-section">
        <h3 class="sales-history-title">Sales History (${purchasedProperties.length})</h3>
        <div class="sales-history-list">
          ${itemsHtml}
        </div>
      </div>
    `;
  }

  marketReportContainer.innerHTML = tempCardHtml + salesHistoryHtml;
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
          return;
        }
        currentPlayers = updatedPlayers;
        if (currentRoom.status === 'in_progress') {
          renderGameHUD();
          renderProperties();
          if (currentGameSubpage === 'make-payments') renderMortgagePayments();
          if (currentGameSubpage === 'financial-report') renderFinancialReport();
          if (currentGameSubpage === 'market-report') renderMarketReport();
          if (currentGameSubpage === 'sell-properties') renderSellProperties();
          if (currentGameSubpage === 'make-improvements') {
            renderMakeImprovements();
            if (pendingImproveProperty) renderImproveModalContent();
          }
          if (currentGameSubpage === 'property-details' && selectedPropertySlug) renderPropertyDetails(selectedPropertySlug);
        } else {
          renderSeats();
        }
      } catch (err) {
        showLandingView();
      }
    },
    async (roomChange) => {
      if (roomChange.new) {
        currentRoom = roomChange.new;
        if (currentRoom.status === 'in_progress') {
          await loadAndShowGameView();
        } else if (currentRoom.status === 'abandoned') {
          showLandingView();
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
        if (currentGameSubpage === 'financial-report') renderFinancialReport();
        if (currentGameSubpage === 'market-report') renderMarketReport();
        if (currentGameSubpage === 'sell-properties') renderSellProperties();
        if (currentGameSubpage === 'make-improvements') {
          renderMakeImprovements();
          if (pendingImproveProperty) renderImproveModalContent();
        }
        if (currentGameSubpage === 'property-details' && selectedPropertySlug) renderPropertyDetails(selectedPropertySlug);
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
  unlockAudio();
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
  unlockAudio();
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
});

// Dashboard Hub Card Navigation
if (cardNavBuyProperties) {
  cardNavBuyProperties.addEventListener('click', () => showGameSubpage('buy-properties'));
  cardNavBuyProperties.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') showGameSubpage('buy-properties');
  });
}

if (cardNavSellProperties) {
  cardNavSellProperties.addEventListener('click', () => showGameSubpage('sell-properties'));
  cardNavSellProperties.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') cardNavSellProperties.click();
  });
}

if (cardNavMakeImprovements) {
  cardNavMakeImprovements.addEventListener('click', () => showGameSubpage('make-improvements'));
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
  cardNavMarketReport.addEventListener('click', () => showGameSubpage('market-report'));
  cardNavMarketReport.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') showGameSubpage('market-report');
  });
}

if (cardNavFinancialReport) {
  cardNavFinancialReport.addEventListener('click', () => showGameSubpage('financial-report'));
  cardNavFinancialReport.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') showGameSubpage('financial-report');
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

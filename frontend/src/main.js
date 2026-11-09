import './style.css';
import QRCode from 'qrcode';
import {
  ensureAnonymousSession,
  createRoom,
  joinRoom,
  fetchRoom,
  leaveRoom,
  resignGame,
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
let propertySales = [];
let propertyForeclosures = [];
let lastAcknowledgedSalesRound = 0;
let lastAcknowledgedDelinquencyRound = 0;
let lastAcknowledgedForeclosureRound = 0;
let currentGameSubpage = 'dashboard';
let selectedPropertySlug = null;
let unsubscribeRealtime = null;
let currentSubscribedRoomId = null;
let lastKnownTurnKey = null;
let lastKnownRound = null;

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

async function playBoxingBell() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;

    // Boxing match double bell strike: "Ding ... Ding!"
    const strikes = [
      { time: now, duration: 0.75, masterGain: 0.32 },
      { time: now + 0.28, duration: 1.5, masterGain: 0.36 }
    ];

    // Authentic brass bell harmonic partials
    const partials = [
      { ratio: 1.0, gain: 0.5, decayMult: 1.0 },     // Fundamental (1250 Hz)
      { ratio: 1.22, gain: 0.28, decayMult: 0.8 },   // Minor third (1525 Hz)
      { ratio: 1.5, gain: 0.2, decayMult: 0.7 },     // Fifth (1875 Hz)
      { ratio: 2.02, gain: 0.16, decayMult: 0.55 },  // Octave overtone (2525 Hz)
      { ratio: 3.1, gain: 0.1, decayMult: 0.35 },    // High metal resonance (3875 Hz)
      { ratio: 4.25, gain: 0.05, decayMult: 0.2 },   // Initial hammer strike bite (5312 Hz)
    ];

    const baseFreq = 1250;

    strikes.forEach(({ time, duration, masterGain }) => {
      partials.forEach(({ ratio, gain, decayMult }) => {
        const osc = ctx.createOscillator();
        const gainNode = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(baseFreq * ratio, time);

        const decayTime = duration * decayMult;
        const peakVol = masterGain * gain;

        gainNode.gain.setValueAtTime(0.0001, time);
        gainNode.gain.exponentialRampToValueAtTime(peakVol, time + 0.002);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, time + decayTime);

        osc.connect(gainNode);
        gainNode.connect(ctx.destination);

        osc.start(time);
        osc.stop(time + decayTime + 0.05);
      });
    });

    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate([100, 50, 150]);
    }
  } catch (err) {
    console.warn('Could not play boxing bell:', err);
  }
}

async function playCashRegisterSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;

    // 1. Mechanical Drawer Latch Click
    const clickOsc = ctx.createOscillator();
    const clickGain = ctx.createGain();
    clickOsc.type = 'triangle';
    clickOsc.frequency.setValueAtTime(320, now);
    clickOsc.frequency.exponentialRampToValueAtTime(80, now + 0.035);
    clickGain.gain.setValueAtTime(0.0001, now);
    clickGain.gain.exponentialRampToValueAtTime(0.2, now + 0.003);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);
    clickOsc.connect(clickGain);
    clickGain.connect(ctx.destination);
    clickOsc.start(now);
    clickOsc.stop(now + 0.04);

    // 2. Bell Chimes: "Cha - CHING!"
    // Strike 1: "cha" at now + 0.04s
    const bell1Time = now + 0.04;
    [1760, 2640].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, bell1Time);
      gain.gain.setValueAtTime(0.0001, bell1Time);
      gain.gain.exponentialRampToValueAtTime(idx === 0 ? 0.22 : 0.08, bell1Time + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, bell1Time + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(bell1Time);
      osc.stop(bell1Time + 0.18);
    });

    // Strike 2: the bright resonant "CHING!" at now + 0.12s
    const bell2Time = now + 0.12;
    [
      { freq: 2637, gainVal: 0.32, dur: 0.7 },  // Main ringing E7
      { freq: 3955, gainVal: 0.14, dur: 0.45 }, // B7 overtone
      { freq: 5274, gainVal: 0.08, dur: 0.25 }  // E8 high sparkle
    ].forEach(({ freq, gainVal, dur }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, bell2Time);
      gain.gain.setValueAtTime(0.0001, bell2Time);
      gain.gain.exponentialRampToValueAtTime(gainVal, bell2Time + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, bell2Time + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(bell2Time);
      osc.stop(bell2Time + dur + 0.02);
    });

    // 3. Coin Jingle / Metallic Shimmer Noise Burst
    const bufferSize = Math.floor(ctx.sampleRate * 0.28);
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    const whiteNoise = ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(6200, now + 0.07);
    filter.Q.setValueAtTime(3.5, now + 0.07);

    const noiseGain = ctx.createGain();
    const noiseTime = now + 0.07;
    noiseGain.gain.setValueAtTime(0.0001, noiseTime);
    noiseGain.gain.exponentialRampToValueAtTime(0.12, noiseTime + 0.015);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, noiseTime + 0.26);

    whiteNoise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(ctx.destination);

    whiteNoise.start(noiseTime);
    whiteNoise.stop(noiseTime + 0.28);

    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate([40, 30, 90]);
    }
  } catch (err) {
    console.warn('Could not play cash register sound:', err);
  }
}

async function playWarningSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;
    [0, 0.16].forEach((offset) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(370, now + offset);
      osc.frequency.exponentialRampToValueAtTime(290, now + offset + 0.12);
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.2, now + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.13);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.14);
    });

    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate([80, 50, 80]);
    }
  } catch (err) {
    // Audio context may be blocked before user interaction
  }
}

async function playForeclosureSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;
    // Heavy gavel strike / alarm sound: lower frequency descending punch
    [0, 0.22].forEach((offset, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(idx === 0 ? 220 : 165, now + offset);
      osc.frequency.exponentialRampToValueAtTime(80, now + offset + 0.18);
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.28, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.22);
    });

    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate([150, 80, 200]);
    }
  } catch (err) {
    // Audio context may be blocked before user interaction
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
const btnResignGame = document.getElementById('btn-resign-game');
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

// Market Temperature Base Odds & Flipstimate
export { MARKET_TEMPERATURE_ODDS, calculateFlipstimate } from './odds.js';
import { calculateFlipstimate } from './odds.js';
export { calculatePlayerEquity, getLeaderboardData } from './leaderboard.js';
import { getLeaderboardData } from './leaderboard.js';
export { getDelinquentProperties } from './delinquency.js';
import { getDelinquentProperties } from './delinquency.js';
export { getDisplayCash, getPendingSalesProceeds } from './wallet.js';
import { getDisplayCash } from './wallet.js';
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

// DOM Elements - Resign Game Modal
const resignGameModal = document.getElementById('resign-game-modal');
const btnCancelResignGame = document.getElementById('btn-cancel-resign-game');
const btnConfirmResignGame = document.getElementById('btn-confirm-resign-game');

// DOM Elements - Game Over / Winner Modal
const gameOverModal = document.getElementById('game-over-modal');
const modalGameOverTitle = document.getElementById('modal-game-over-title');
const modalGameOverDesc = document.getElementById('modal-game-over-desc');
const modalGameOverStats = document.getElementById('modal-game-over-stats');
const btnGameOverHome = document.getElementById('btn-game-over-home');

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
const modalListAlertBox = document.getElementById('modal-list-alert-box');
const modalListAlertMsg = document.getElementById('modal-list-alert-msg');

let pendingListProperty = null;
let pendingListGameProperty = null;

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

// DOM Elements - Market Sales Modal (Turn Start Alert)
const marketSalesModal = document.getElementById('market-sales-modal');
const modalSalesTitle = document.getElementById('modal-sales-title');
const modalSalesSubtitle = document.getElementById('modal-sales-subtitle');
const modalSalesContent = document.getElementById('modal-sales-content');
const btnCloseSalesModal = document.getElementById('btn-close-sales-modal');

// DOM Elements - Delinquency Alert Modal (Turn Start Alert)
const delinquencyAlertModal = document.getElementById('delinquency-alert-modal');
const modalDelinquencyTitle = document.getElementById('modal-delinquency-title');
const modalDelinquencySubtitle = document.getElementById('modal-delinquency-subtitle');
const modalDelinquencyContent = document.getElementById('modal-delinquency-content');
const btnCloseDelinquencyModal = document.getElementById('btn-close-delinquency-modal');

// DOM Elements - Foreclosure Alert Modal (Turn Start Alert)
const foreclosureAlertModal = document.getElementById('foreclosure-alert-modal');
const modalForeclosureTitle = document.getElementById('modal-foreclosure-title');
const modalForeclosureSubtitle = document.getElementById('modal-foreclosure-subtitle');
const modalForeclosureContent = document.getElementById('modal-foreclosure-content');
const btnCloseForeclosureModal = document.getElementById('btn-close-foreclosure-modal');

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
  lastKnownRound = null;

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
  currentSubscribedRoomId = null;
  currentRoom = null;
  currentPlayers = [];
  lastKnownTurnKey = null;
  lastKnownRound = null;
  lastAcknowledgedSalesRound = 0;
  lastAcknowledgedDelinquencyRound = 0;
  lastAcknowledgedForeclosureRound = 0;
  propertyForeclosures = [];
  if (foreclosureAlertModal) foreclosureAlertModal.classList.add('hidden');
  if (delinquencyAlertModal) delinquencyAlertModal.classList.add('hidden');
  if (marketSalesModal) marketSalesModal.classList.add('hidden');
  currentGameSubpage = 'dashboard';
  setRoomUrl(null);
  closeQrModal();
  closeEndGameModal();
  closeResignModal();
  closeGameOverModal();

  if (btnResignGame) btnResignGame.classList.add('hidden');
  if (btnGameEnd) btnGameEnd.classList.add('hidden');

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
    propertySales = data.propertySales || [];
    propertyForeclosures = data.propertyForeclosures || [];

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
  let isNewRoundTransition = false;
  if (currentRoom) {
    const currentRoundNum = currentRoom.current_round || 1;
    if (roundNumberDisplay) {
      roundNumberDisplay.textContent = currentRoundNum;
    }
    if (lastKnownRound !== null && currentRoundNum > lastKnownRound) {
      isNewRoundTransition = true;
      playBoxingBell();
    }
    lastKnownRound = currentRoundNum;
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
      // When a new round begins, only the boxing bell plays — skip the turn chime
      if (!isNewRoundTransition) {
        playTurnChime();
      }
    }
  } else {
    turnIndicatorBox.classList.remove('is-my-turn');
    btnEndTurn.disabled = true;
    btnEndTurn.title = 'Wait your turn';
  }

  // Wallet (if present)
  if (myPlayer && myWalletDisplay) {
    const displayCash = getDisplayCash(myPlayer, currentRoom?.current_round, lastAcknowledgedSalesRound, propertySales);
    myWalletDisplay.textContent = formatMoney(displayCash);
  }

  // Resign Game control (available to all players during active game)
  if (btnResignGame) {
    if (currentRoom?.status === 'in_progress') {
      btnResignGame.classList.remove('hidden');
    } else {
      btnResignGame.classList.add('hidden');
    }
  }

  // Host Controls
  if (myPlayer?.is_host) {
    btnGameEnd.classList.remove('hidden');
  } else {
    btnGameEnd.classList.add('hidden');
  }

  // Turn-start alerts check (Delinquency first, then Sales)
  checkTurnStartAlerts();
}

// Render Zillow-Style Properties Feed
function renderProperties() {
  propertiesGrid.innerHTML = '';

  const availableProperties = catalogProperties.filter((prop) => {
    const gp = gameProperties.find((g) => g.property_slug === prop.slug);
    // Sold to outside buyer: permanently off the market
    if (gp && gp.is_sold_to_buyer) return false;
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
      playCashRegisterSound();
      closePurchaseModal();

      const { room, players, gameProperties: updatedProps, propertySales: updatedSales } = await fetchGameData(currentRoom.id);
      currentRoom = room;
      currentPlayers = players;
      gameProperties = updatedProps;
      propertySales = updatedSales || [];

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
    const installedImprovements = Array.isArray(gp.improvements) ? gp.improvements : [];
    const isUnimproved = installedImprovements.length === 0;
    const flipstimate = calculateFlipstimate(gp, currentRoom);

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
        } else if (isUnimproved) {
          actionBtnHtml = `
            <button class="btn-detail-buy" disabled title="You cannot list an unimproved property. Make at least one improvement before listing.">
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
            <span class="property-detail-stat-label">Flipstimate</span>
            <span class="property-detail-stat-val">${flipstimate}</span>
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
          const { room, players, gameProperties: updatedProps, propertySales: updatedSales } = await fetchGameData(currentRoom.id);
          currentRoom = room;
          currentPlayers = players;
          gameProperties = updatedProps;
          propertySales = updatedSales || [];
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

// List Property Modal Alert Helpers
function showListModalAlert(message) {
  if (!modalListAlertBox || !modalListAlertMsg) return;
  modalListAlertMsg.textContent = message;
  modalListAlertBox.classList.remove('hidden');
}

function hideListModalAlert() {
  if (modalListAlertBox) {
    modalListAlertBox.classList.add('hidden');
  }
}

if (modalListPriceInput) {
  modalListPriceInput.addEventListener('input', hideListModalAlert);
}

// List Property Modal Logic
function openListModal(prop, gp) {
  if (!prop || !currentRoom) return;
  pendingListProperty = prop;
  pendingListGameProperty = gp;
  hideListModalAlert();

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
  hideListModalAlert();
  pendingListProperty = null;
  pendingListGameProperty = null;
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
      showListModalAlert('Please enter a valid asking price between $1 and $10,000,000.');
      modalListPriceInput.focus();
      return;
    }

    const mortgageBal = pendingListGameProperty?.mortgage_balance || 0;
    if (askingPrice < mortgageBal) {
      showListModalAlert(`List price must be at least the remaining mortgage balance (${formatMoney(mortgageBal)}).`);
      modalListPriceInput.focus();
      return;
    }

    btnConfirmListProperty.disabled = true;
    btnConfirmListProperty.textContent = 'Listing...';

    try {
      await listProperty(currentRoom.id, pendingListProperty.slug, askingPrice);
      closeListModal();

      const { room, players, gameProperties: updatedProps, propertySales: updatedSales } = await fetchGameData(currentRoom.id);
      currentRoom = room;
      currentPlayers = players;
      gameProperties = updatedProps;
      propertySales = updatedSales || [];

      renderGameHUD();
      renderProperties();
      renderSellProperties();
    } catch (err) {
      showListModalAlert(err.message || 'Failed to list property.');
      btnConfirmListProperty.disabled = false;
      btnConfirmListProperty.textContent = pendingListGameProperty?.is_listed ? 'Update Asking Price' : 'List for Sale';
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
          Install
        </button>
      `;
    } else {
      actionBtnHtml = `
        <button class="btn-install-improvement btn-modal-install" data-slug="${prop.slug}" data-key="${imp.key}">
          Install
        </button>
      `;
    }

    const itemDiv = document.createElement('div');
    itemDiv.className = `improvement-item ${isInstalled ? 'is-installed' : ''}`;
    itemDiv.innerHTML = `
      <div class="improvement-info">
        <div class="improvement-title">
          ${escapeHtml(imp.name)}
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
          playCashRegisterSound();
          const { room, players, gameProperties: updatedProps, propertySales: updatedSales } = await fetchGameData(currentRoom.id);
          currentRoom = room;
          currentPlayers = players;
          gameProperties = updatedProps;
          propertySales = updatedSales || [];

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

if (btnCloseDelinquencyModal) {
  btnCloseDelinquencyModal.addEventListener('click', closeDelinquencyModal);
}

if (delinquencyAlertModal) {
  delinquencyAlertModal.addEventListener('click', (e) => {
    if (e.target === delinquencyAlertModal) closeDelinquencyModal();
  });
}

if (btnCloseSalesModal) {
  btnCloseSalesModal.addEventListener('click', () => {
    if (marketSalesModal) marketSalesModal.classList.add('hidden');
    lastAcknowledgedSalesRound = currentRoom?.current_round || 0;
  });
}

if (marketSalesModal) {
  marketSalesModal.addEventListener('click', (e) => {
    if (e.target === marketSalesModal) {
      marketSalesModal.classList.add('hidden');
      lastAcknowledgedSalesRound = currentRoom?.current_round || 0;
    }
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
          playCashRegisterSound();
          const { room, players, gameProperties: updatedProps, propertySales: updatedSales } = await fetchGameData(currentRoom.id);
          currentRoom = room;
          currentPlayers = players;
          gameProperties = updatedProps;
          propertySales = updatedSales || [];
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
  const cash = getDisplayCash(myPlayer, currentRoom?.current_round, lastAcknowledgedSalesRound, propertySales);
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

  // 2. Leaderboard Card (Ranked by Total Equity descending)
  const rankedPlayers = getLeaderboardData(currentPlayers, gameProperties, catalogProperties);
  let leaderboardCardHtml = '';
  if (rankedPlayers.length > 0) {
    const playerRowsHtml = rankedPlayers.map((p) => {
      const rankClass = p.rank <= 3 ? `rank-${p.rank}` : '';
      return `
        <div class="market-leaderboard-item">
          <div class="leaderboard-player-left">
            <span class="leaderboard-rank ${rankClass}">#${p.rank}</span>
            <span class="leaderboard-name">${escapeHtml(p.displayName)}</span>
          </div>
          <span class="leaderboard-equity">${formatMoney(p.equity)}</span>
        </div>
      `;
    }).join('');

    leaderboardCardHtml = `
      <div class="market-leaderboard-card">
        <div class="market-leaderboard-header">
          <h3 class="market-leaderboard-title">Leaderboard</h3>
        </div>
        <div class="market-leaderboard-list">
          ${playerRowsHtml}
        </div>
      </div>
    `;
  }

  // 3. Sales History Section: Show all sales sorted by most recent round
  const salesToDisplay = (propertySales && propertySales.length > 0)
    ? [...propertySales].sort((a, b) => (b.round_number || 0) - (a.round_number || 0) || new Date(b.created_at || 0) - new Date(a.created_at || 0))
    : gameProperties
        .filter((gp) => gp.purchased_round != null)
        .map((gp) => {
          const prop = catalogProperties.find((cp) => cp.slug === gp.property_slug);
          const buyer = currentPlayers.find((p) => p.user_id === gp.owner_user_id);
          return {
            property_slug: gp.property_slug,
            buyer_name: buyer ? buyer.display_name : 'Player',
            sale_price: gp.purchase_price || prop?.cost || 0,
            round_number: gp.purchased_round,
            buyer_type: 'player'
          };
        })
        .sort((a, b) => (b.round_number || 0) - (a.round_number || 0));

  let salesHistoryHtml = '';
  if (salesToDisplay.length === 0) {
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
    const itemsHtml = salesToDisplay.map((s) => {
      const prop = catalogProperties.find((cp) => cp.slug === s.property_slug);
      if (!prop) return '';

      const isAutomated = s.buyer_type === 'automated';
      const metaText = isAutomated
        ? `Seller: ${escapeHtml(s.seller_name || 'Player')} • Buyer: ${escapeHtml(s.buyer_name)}`
        : `Buyer: ${escapeHtml(s.buyer_name)}`;

      return `
        <div class="sales-history-item">
          <div class="sales-history-stripe" style="background-color: ${prop.color_hex};"></div>
          <div class="sales-history-content">
            <div class="sales-history-prop-group">
              <span class="sales-history-prop-name">${escapeHtml(prop.name)}</span>
              <div class="sales-history-meta">
                <span>${metaText}</span>
              </div>
            </div>
            <div class="sales-history-price-group">
              <span class="sales-history-price">${formatMoney(s.sale_price)}</span>
              <span class="sales-history-badge">Round ${s.round_number}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    salesHistoryHtml = `
      <div class="sales-history-section">
        <h3 class="sales-history-title">Sales History (${salesToDisplay.length})</h3>
        <div class="sales-history-list">
          ${itemsHtml}
        </div>
      </div>
    `;
  }

  // 4. Foreclosure History Section: Show all bank foreclosures
  let foreclosureHistoryHtml = '';
  if (propertyForeclosures && propertyForeclosures.length > 0) {
    const itemsHtml = propertyForeclosures.map((f) => {
      const prop = catalogProperties.find((cp) => cp.slug === f.property_slug);
      const propName = prop ? prop.name : f.property_slug;
      const color = prop ? prop.color_hex : '#dc2626';
      return `
        <div class="sales-history-item" style="border-left: 4px solid #dc2626;">
          <div class="sales-history-stripe" style="background-color: ${color};"></div>
          <div class="sales-history-content">
            <div class="sales-history-prop-group">
              <span class="sales-history-prop-name">${escapeHtml(propName)}</span>
              <div class="sales-history-meta">
                <span style="color: #ef4444;">Foreclosed from: ${escapeHtml(f.owner_name)}</span>
              </div>
            </div>
            <div class="sales-history-price-group">
              <span class="badge" style="background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid #ef4444; font-weight: 700; font-size: 0.75rem;">BANK REPOSSESSED</span>
              <span class="sales-history-badge">Round ${f.round_number}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    foreclosureHistoryHtml = `
      <div class="sales-history-section" style="margin-top: 1.5rem;">
        <h3 class="sales-history-title" style="color: #ef4444;">Foreclosure History (${propertyForeclosures.length})</h3>
        <div class="sales-history-list">
          ${itemsHtml}
        </div>
      </div>
    `;
  }

  marketReportContainer.innerHTML = tempCardHtml + leaderboardCardHtml + salesHistoryHtml + foreclosureHistoryHtml;
}

// Turn-Start Alerts Coordination:
// 1. Foreclosure Alert (most critical - property already seized)
// 2. Delinquency Warning (at risk this round)
// 3. Sales Report (proceeds earned)
function checkTurnStartAlerts() {
  if (!currentRoom || currentRoom.status !== 'in_progress') return;
  const myPlayer = currentPlayers.find((p) => p.user_id === currentUser?.id);
  if (!myPlayer) return;

  const isMyTurn = currentRoom.current_turn_seat === myPlayer.seat_number;
  if (!isMyTurn) return;

  // 1. Check for Foreclosed Properties
  if (checkTurnStartForeclosureModal()) {
    return;
  }

  // 2. Check for Delinquent Properties
  if (checkTurnStartDelinquencyModal()) {
    return;
  }

  // 3. Check for Automated Sales
  checkTurnStartSalesModal();
}

function checkTurnStartForeclosureModal() {
  if (!foreclosureAlertModal || !currentRoom || currentRoom.status !== 'in_progress') return false;
  const myPlayer = currentPlayers.find((p) => p.user_id === currentUser?.id);
  if (!myPlayer) return false;

  const isMyTurn = currentRoom.current_turn_seat === myPlayer.seat_number;
  if (!isMyTurn) return false;

  if (lastAcknowledgedForeclosureRound >= currentRoom.current_round) return false;

  const previousRound = (currentRoom.current_round || 1) - 1;
  const myForeclosures = (propertyForeclosures || []).filter(
    (f) => f.owner_user_id === currentUser?.id && f.round_number === previousRound
  );

  if (myForeclosures.length === 0) {
    return false;
  }

  lastAcknowledgedForeclosureRound = currentRoom.current_round;
  showForeclosureModal(myForeclosures);
  return true;
}

function showForeclosureModal(foreclosures) {
  if (!foreclosureAlertModal || !modalForeclosureContent) return;

  const count = foreclosures.length;
  modalForeclosureTitle.textContent = count === 1 ? 'Property Foreclosed!' : 'Properties Foreclosed!';
  modalForeclosureSubtitle.textContent = `The bank has seized ${count === 1 ? 'a property' : `${count} properties`} due to unpaid mortgage delinquency.`;

  let html = `
    <div style="background: rgba(220, 38, 38, 0.12); border: 1px solid rgba(220, 38, 38, 0.4); border-radius: 8px; padding: 0.85rem 1rem; margin-bottom: 0.5rem;">
      <div style="font-size: 1.05rem; font-weight: 800; color: #ef4444; margin-bottom: 0.25rem;">
        🏦 Seized by the Bank
      </div>
      <div style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.45;">
        You missed two consecutive mortgage payments on ${count === 1 ? 'this property' : 'these properties'}. The bank has cleared the outstanding mortgage debt and returned the deed to the marketplace as available inventory.
      </div>
    </div>
  `;

  foreclosures.forEach((f) => {
    const prop = catalogProperties.find((cp) => cp.slug === f.property_slug);
    const propName = prop ? prop.name : f.property_slug;
    const color = prop ? prop.color_hex : '#dc2626';
    const numImprovements = Array.isArray(f.improvements) ? f.improvements.length : 0;

    html += `
      <div class="foreclosure-alert-item">
        <div class="foreclosure-alert-header">
          <span class="delinquency-alert-prop-name">
            <span class="delinquency-alert-dot" style="background-color: ${color};"></span>
            ${escapeHtml(propName)}
          </span>
          <span class="foreclosure-alert-badge">REPOSSESSED</span>
        </div>
        <div class="foreclosure-alert-details">
          <div class="delinquency-alert-breakdown">
            <span>Status:</span>
            <strong style="color: #ef4444; font-weight: 700;">Returned to Bank</strong>
          </div>
          <div class="delinquency-alert-breakdown">
            <span>Mortgage Balance:</span>
            <strong style="color: #22c55e; font-weight: 600;">Cleared to $0</strong>
          </div>
          ${numImprovements > 0 ? `
          <div class="delinquency-alert-breakdown">
            <span>Improvements Preserved:</span>
            <strong style="color: #38bdf8; font-weight: 600;">${numImprovements} installed</strong>
          </div>` : ''}
        </div>
      </div>
    `;
  });

  modalForeclosureContent.innerHTML = html;
  foreclosureAlertModal.classList.remove('hidden');
}

function closeForeclosureModal() {
  if (foreclosureAlertModal) {
    foreclosureAlertModal.classList.add('hidden');
  }
  // Next in sequence: check Delinquency, or if none, check Sales
  if (!checkTurnStartDelinquencyModal()) {
    checkTurnStartSalesModal();
  }
}

function checkTurnStartDelinquencyModal() {
  if (!delinquencyAlertModal || !currentRoom || currentRoom.status !== 'in_progress') return false;
  const myPlayer = currentPlayers.find((p) => p.user_id === currentUser?.id);
  if (!myPlayer) return false;

  const isMyTurn = currentRoom.current_turn_seat === myPlayer.seat_number;
  if (!isMyTurn) return false;

  const myDelinquentProps = getDelinquentProperties(currentUser?.id, gameProperties, currentRoom.current_round);

  if (myDelinquentProps.length > 0 && lastAcknowledgedDelinquencyRound < currentRoom.current_round) {
    lastAcknowledgedDelinquencyRound = currentRoom.current_round;
    showDelinquencyModal(myDelinquentProps);
    return true;
  }

  return false;
}

function showDelinquencyModal(delinquentProps) {
  if (!delinquencyAlertModal || !modalDelinquencyContent) return;

  const count = delinquentProps.length;
  modalDelinquencyTitle.textContent = 'Mortgage Delinquency Warning';
  modalDelinquencySubtitle.textContent = `You have ${count} ${count === 1 ? 'property' : 'properties'} with past-due mortgage payments. If left unpaid by the end of Round ${currentRoom.current_round}, ${count === 1 ? 'it' : 'they'} will be foreclosed!`;

  let html = `
    <div style="background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 8px; padding: 0.85rem 1rem; margin-bottom: 0.5rem;">
      <div style="font-size: 1.05rem; font-weight: 800; color: #f87171; margin-bottom: 0.25rem;">
        ⚠️ Foreclosure Threat
      </div>
      <div style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.45;">
        You missed a mortgage payment last round. To prevent losing your investment, go to <strong>Make Payments</strong> to make a single payment (to stave off foreclosure) or double payment (to bring current).
      </div>
    </div>
  `;

  delinquentProps.forEach((gp) => {
    const prop = catalogProperties.find((cp) => cp.slug === gp.property_slug);
    const propName = prop ? prop.name : gp.property_slug;
    const color = prop ? prop.color_hex : '#ef4444';
    const singlePayment = prop ? Math.floor(prop.cost / 40) : 0;
    const mortgageBalance = gp.mortgage_balance || 0;

    html += `
      <div class="delinquency-alert-item">
        <div class="delinquency-alert-header">
          <span class="delinquency-alert-prop-name">
            <span class="delinquency-alert-dot" style="background-color: ${color};"></span>
            ${escapeHtml(propName)}
          </span>
          <span class="delinquency-alert-badge">Delinquent</span>
        </div>
        <div class="delinquency-alert-details">
          <div class="delinquency-alert-breakdown">
            <span>Payment to Stave Off:</span>
            <strong style="color: #f87171; font-weight: 700;">${formatMoney(singlePayment)}</strong>
          </div>
          <div class="delinquency-alert-breakdown">
            <span>Remaining Mortgage Balance:</span>
            <strong style="color: var(--text-main); font-weight: 600;">${formatMoney(mortgageBalance)}</strong>
          </div>
        </div>
      </div>
    `;
  });

  modalDelinquencyContent.innerHTML = html;
  delinquencyAlertModal.classList.remove('hidden');
}

function closeDelinquencyModal() {
  if (delinquencyAlertModal) {
    delinquencyAlertModal.classList.add('hidden');
  }
  // Check if sales modal should appear next
  checkTurnStartSalesModal();
}

// Turn-Start Notification: Market Sales Modal Alert
function checkTurnStartSalesModal() {
  if (!marketSalesModal || !currentRoom || currentRoom.status !== 'in_progress') return;
  const myPlayer = currentPlayers.find((p) => p.user_id === currentUser?.id);
  if (!myPlayer) return;

  const isMyTurn = currentRoom.current_turn_seat === myPlayer.seat_number;
  if (!isMyTurn) return;

  // Only check once per round per player
  if (lastAcknowledgedSalesRound >= currentRoom.current_round) return;

  // Look for automated sales that occurred during the transition to this round (round_number === currentRoom.current_round - 1)
  const previousRound = (currentRoom.current_round || 1) - 1;
  const recentSales = (propertySales || []).filter(
    (s) => s.buyer_type === 'automated' && s.round_number === previousRound
  );

  // If no sales have arrived yet in local state, allow re-checking on subsequent realtime updates
  if (recentSales.length === 0) {
    return;
  }

  // Filter ONLY sales belonging to the current player (personal turn-start alert)
  const mySales = recentSales.filter((s) => s.seller_user_id === currentUser?.id);

  // If this player had no sales in the round transition, acknowledge this round and do not display modal
  if (mySales.length === 0) {
    lastAcknowledgedSalesRound = currentRoom.current_round;
    return;
  }

  // Mark as acknowledged immediately so subsequent re-renders during this turn do not re-trigger
  lastAcknowledgedSalesRound = currentRoom.current_round;

  // Immediately reflect the credited balance at the start of the turn
  if (myPlayer && myWalletDisplay) {
    myWalletDisplay.textContent = formatMoney(myPlayer.cash);
  }
  if (currentGameSubpage === 'financial-report') {
    renderFinancialReport();
  }

  const count = mySales.length;
  modalSalesTitle.textContent = count === 1 ? '🎉 Property Sold!' : `🎉 ${count} Properties Sold!`;
  modalSalesSubtitle.textContent = count === 1
    ? `An automated buyer purchased your property at the close of Round ${previousRound}.`
    : `Automated buyers purchased ${count} of your properties at the close of Round ${previousRound}.`;

  let html = `
    <div style="background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.35); border-radius: 8px; padding: 0.85rem 1rem; margin-bottom: 0.5rem;">
      <div style="font-size: 1.05rem; font-weight: 800; color: #22c55e; margin-bottom: 0.25rem;">
        ${count === 1 ? 'Proceeds Credited to Your Account' : 'All Proceeds Credited to Your Account'}
      </div>
      <div style="font-size: 0.85rem; color: var(--text-muted);">
        Outstanding mortgages were paid off in full and net proceeds have been deposited into your bank balance.
      </div>
    </div>
  `;

  mySales.forEach((s) => {
    const prop = catalogProperties.find((cp) => cp.slug === s.property_slug);
    const propName = prop ? prop.name : s.property_slug;
    const color = prop ? prop.color_hex : '#22c55e';

    html += `
      <div class="sale-alert-item sale-alert-mine">
        <div class="sale-alert-header">
          <span class="sale-alert-prop-name">
            <span class="sale-alert-dot" style="background-color: ${color};"></span>
            ${escapeHtml(propName)}
          </span>
          <span class="sale-alert-price">${formatMoney(s.sale_price)}</span>
        </div>
        <div class="sale-alert-details">
          <div class="sale-alert-breakdown">
            <span>Buyer:</span>
            <strong style="color: var(--text-main);">${escapeHtml(s.buyer_name)}</strong>
          </div>
          <div class="sale-alert-breakdown">
            <span>Mortgage Paid Off:</span>
            <strong style="color: #ef4444;">-${formatMoney(s.mortgage_paid)}</strong>
          </div>
          <div class="sale-alert-breakdown" style="border-top: 1px dashed rgba(51, 65, 85, 0.4); padding-top: 0.3rem; margin-top: 0.2rem;">
            <span>Net Cash Deposited:</span>
            <strong class="sale-alert-net">+${formatMoney(s.net_proceeds)}</strong>
          </div>
        </div>
      </div>
    `;
  });

  modalSalesContent.innerHTML = html;
  marketSalesModal.classList.remove('hidden');
}

// Realtime subscriptions
function setupRealtimeSubscription(roomId) {
  if (currentSubscribedRoomId === roomId && unsubscribeRealtime) {
    return;
  }
  if (unsubscribeRealtime) {
    unsubscribeRealtime();
    unsubscribeRealtime = null;
  }
  currentSubscribedRoomId = roomId;

  unsubscribeRealtime = subscribeToRoom(
    roomId,
    async () => {
      try {
        const { room: latestRoom, players: updatedPlayers, gameProperties: updatedProps, propertySales: updatedSales, propertyForeclosures: updatedForeclosures } = await fetchGameData(roomId);
        if (latestRoom.status === 'abandoned') {
          showLandingView();
          return;
        }
        if (latestRoom.status === 'completed') {
          currentRoom = latestRoom;
          currentPlayers = updatedPlayers;
          gameProperties = updatedProps;
          propertySales = updatedSales || [];
          propertyForeclosures = updatedForeclosures || [];
          showGameOverModal();
          return;
        }
        currentRoom = latestRoom;
        currentPlayers = updatedPlayers;
        gameProperties = updatedProps;
        propertySales = updatedSales || [];
        propertyForeclosures = updatedForeclosures || [];
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
        } else if (currentRoom.status === 'completed') {
          showGameOverModal();
        }
      }
    },
    async () => {
      // Game property ownership changes
      try {
        const { gameProperties: updatedProps, players: updatedPlayers, propertySales: updatedSales, propertyForeclosures: updatedForeclosures } = await fetchGameData(roomId);
        gameProperties = updatedProps;
        currentPlayers = updatedPlayers;
        propertySales = updatedSales || [];
        propertyForeclosures = updatedForeclosures || [];
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
    },
    async () => {
      // Property sales & foreclosures updates
      try {
        const { propertySales: updatedSales, propertyForeclosures: updatedForeclosures, players: updatedPlayers, gameProperties: updatedProps } = await fetchGameData(roomId);
        propertySales = updatedSales || [];
        propertyForeclosures = updatedForeclosures || [];
        currentPlayers = updatedPlayers;
        gameProperties = updatedProps;
        renderGameHUD();
        renderProperties();
        if (currentGameSubpage === 'market-report') renderMarketReport();
        if (currentGameSubpage === 'financial-report') renderFinancialReport();
      } catch (err) {
        console.error('Error refreshing sales and foreclosures:', err);
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
    await endTurn(currentRoom.id);
    const { room, players, gameProperties: updatedProps, propertySales: updatedSales } = await fetchGameData(currentRoom.id);
    currentRoom = room;
    currentPlayers = players;
    gameProperties = updatedProps;
    propertySales = updatedSales || [];

    renderGameHUD();
    renderProperties();
    if (currentGameSubpage === 'sell-properties') renderSellProperties();
    if (currentGameSubpage === 'make-payments') renderMortgagePayments();
    if (currentGameSubpage === 'financial-report') renderFinancialReport();
    if (currentGameSubpage === 'market-report') renderMarketReport();
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

function openResignModal() {
  if (resignGameModal) resignGameModal.classList.remove('hidden');
}

function closeResignModal() {
  if (resignGameModal) resignGameModal.classList.add('hidden');
}

function showGameOverModal() {
  if (!gameOverModal) return;
  const winner = currentPlayers[0];
  const isWinner = winner?.user_id === currentUser?.id;

  if (modalGameOverTitle) {
    modalGameOverTitle.textContent = isWinner ? '🏆 Victory!' : 'Game Over';
  }
  if (modalGameOverDesc) {
    modalGameOverDesc.textContent = isWinner
      ? 'All opponents have resigned. You are the last flipper standing!'
      : `${winner?.display_name || 'Opponent'} is the last flipper standing!`;
  }

  if (modalGameOverStats && winner) {
    const equity = calculatePlayerEquity(winner, gameProperties, catalogProperties);
    const ownedProps = gameProperties.filter((gp) => gp.owner_user_id === winner.user_id && !gp.is_sold_to_buyer);
    modalGameOverStats.innerHTML = `
      <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
        <span style="color: var(--text-muted); font-size: 0.9rem;">Winner:</span>
        <span style="font-weight: 700; color: #f59e0b;">${escapeHtml(winner.display_name)} (Seat ${winner.seat_number})</span>
      </div>
      <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
        <span style="color: var(--text-muted); font-size: 0.9rem;">Final Cash:</span>
        <span style="font-weight: 700; color: #38bdf8;">${formatMoney(winner.cash)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
        <span style="color: var(--text-muted); font-size: 0.9rem;">Properties Owned:</span>
        <span style="font-weight: 700;">${ownedProps.length}</span>
      </div>
      <div style="display: flex; justify-content: space-between; border-top: 1px solid var(--border-color); padding-top: 0.5rem; margin-top: 0.5rem;">
        <span style="color: var(--text-muted); font-size: 0.9rem; font-weight: 700;">Total Equity:</span>
        <span style="font-weight: 800; color: #22c55e; font-size: 1.1rem;">${formatMoney(equity)}</span>
      </div>
    `;
  }

  gameOverModal.classList.remove('hidden');
}

function closeGameOverModal() {
  if (gameOverModal) gameOverModal.classList.add('hidden');
}

btnGameEnd.addEventListener('click', openEndGameModal);
btnCancelEndGame.addEventListener('click', closeEndGameModal);

if (btnResignGame) btnResignGame.addEventListener('click', openResignModal);
if (btnCancelResignGame) btnCancelResignGame.addEventListener('click', closeResignModal);

if (resignGameModal) {
  resignGameModal.addEventListener('click', (e) => {
    if (e.target === resignGameModal) closeResignModal();
  });
}

if (btnGameOverHome) {
  btnGameOverHome.addEventListener('click', () => {
    closeGameOverModal();
    showLandingView();
  });
}

if (btnCloseForeclosureModal) {
  btnCloseForeclosureModal.addEventListener('click', closeForeclosureModal);
}

if (foreclosureAlertModal) {
  foreclosureAlertModal.addEventListener('click', (e) => {
    if (e.target === foreclosureAlertModal) closeForeclosureModal();
  });
}

endGameModal.addEventListener('click', (e) => {
  if (e.target === endGameModal) closeEndGameModal();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (foreclosureAlertModal && !foreclosureAlertModal.classList.contains('hidden')) {
      closeForeclosureModal();
    }
    if (delinquencyAlertModal && !delinquencyAlertModal.classList.contains('hidden')) {
      closeDelinquencyModal();
    }
    if (marketSalesModal && !marketSalesModal.classList.contains('hidden')) {
      marketSalesModal.classList.add('hidden');
      lastAcknowledgedSalesRound = currentRoom?.current_round || 0;
    }
    if (!endGameModal.classList.contains('hidden')) closeEndGameModal();
    if (resignGameModal && !resignGameModal.classList.contains('hidden')) closeResignModal();
    if (gameOverModal && !gameOverModal.classList.contains('hidden')) {
      closeGameOverModal();
      showLandingView();
    }
    if (!qrModal.classList.contains('hidden')) closeQrModal();
    if (listPropertyModal && !listPropertyModal.classList.contains('hidden')) closeListModal();
    if (purchaseConfirmModal && !purchaseConfirmModal.classList.contains('hidden')) closePurchaseModal();
    if (improvePropertyModal && !improvePropertyModal.classList.contains('hidden')) closeImproveModal();
  }
});

if (btnConfirmResignGame) {
  btnConfirmResignGame.addEventListener('click', async () => {
    if (!currentRoom) return;
    const wasRoomId = currentRoom.id;
    btnConfirmResignGame.disabled = true;
    closeResignModal();
    try {
      await resignGame(wasRoomId);
    } catch (err) {
      console.error('Error resigning game:', err);
      showAlert(err.message || 'Failed to resign game.');
    } finally {
      btnConfirmResignGame.disabled = false;
    }
    showLandingView();
  });
}

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

/* Snakes & Ladders MP — entry point.
 *
 * Wires room flows (create / join / lobby / start / leave / end / play again)
 * and gameplay (board, dice, animations, results).
 */

import { showScreen, showToast } from './platform-ui.js';
import { initDeepLinkHandler, createShareHandler, showQRCode } from './deep-link-handler.js';
import {
  createRoom,
  joinRoom,
  listenRoom,
  setupDisconnectHandler,
  stopPresenceTracking,
  leavePlayer,
  removePlayer,
  endRoom,
  deleteRoom,
  resetRoom,
  startGameState,
  commitMove,
  firebaseRetry,
  setPlayerReady,
} from './firebase-sync.js';
import {
  createGame,
  applyRoll,
  serializeState,
  deserializeState,
  validateState,
  TOTAL,
  SNAKES,
  LADDERS,
} from './engine.js';
import {
  buildGrid,
  setBoardSkin,
  getBoardIndex,
  createTokens,
  placeTokens,
  updateTokenSize,
  highlightActiveToken,
  throwDiceVisual,
  resetDice,
  animateSteps,
  animateSnakeOrLadder,
  animateCaptureToken,
  playSound,
  setMessage,
  setTurn,
  renderPositions,
  setRollButtonState,
  isMuted,
  toggleMute,
  startBackgroundMusic,
  stopBackgroundMusic,
  pauseBackgroundMusic,
  resumeBackgroundMusic,
  setActiveSpeakers,
} from './ui.js';
import { db, auth, authReady } from './firebase-config.js';
import { ref, get, onValue, off } from 'firebase/database';
import { mountVoiceChat } from './voice-chat-widget.js';

/* ======= CONSTANTS ======= */

const SESSION_KEY = 'snl_mp_session';

/* ======= STATE ======= */

let state = null;
let roomCode = null;
let playerIndex = null;
let isHost = false;
let playerNames = [];
let roomPlayers = {};
let unsubscribeRoom = null;
let _resultsShown = false;
let voiceWidget = null;

/* ======= SESSION PERSISTENCE ======= */

function saveSession() {
  if (roomCode != null && playerIndex != null) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode, playerIndex }));
    } catch (_) {}
  }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
}
function loadSession() {
  try { const r = localStorage.getItem(SESSION_KEY); return r ? JSON.parse(r) : null; } catch (_) { return null; }
}

/* ======= VOICE CHAT (optional, LiveKit, voice-only) =======
 * Uses the standardized self-contained widget (see voice-chat-widget.js).
 * Mounted lazily on first game start; torn down when leaving the room.
 */

function cleanupAndGoHome() {
  if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
  if (window._snlReadyCleanup) window._snlReadyCleanup();
  if (voiceWidget) { try { voiceWidget.stop(); } catch (_) {} }
  stopJoinPreviewListener();
  stopPresenceTracking();
  stopBackgroundMusic();
  clearSession();
  roomCode = null;
  playerIndex = null;
  isHost = false;
  playerNames = [];
  roomPlayers = {};
  state = null;
  _pendingRemoteUpdate = null;
  _resultsShown = false;
  showScreen('home');
}

/* ======= EMOJI PICKER ======= */

function wireEmojiPicker(selector) {
  const picker = document.querySelector(selector);
  if (!picker) return;
  const btns = picker.querySelectorAll('.emoji-btn');
  btns.forEach((btn) => {
    btn.addEventListener('click', () => {
      btns.forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });
}

function getSelectedEmoji(selector) {
  const sel = document.querySelector(`${selector} .emoji-btn.selected`);
  return sel?.dataset.emoji || '👲';
}

/* ======= COLOR PICKER ======= */

function wireColorPicker(selector) {
  const picker = document.querySelector(selector);
  if (!picker) return;
  const btns = picker.querySelectorAll('.color-btn');
  btns.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('taken')) return;
      btns.forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });
}

function getSelectedColor(selector) {
  const sel = document.querySelector(`${selector} .color-btn.selected`);
  return sel?.dataset.color || 'red';
}

/**
 * Marks a list of colors as taken (dimmed) on a picker, and ensures the
 * selected color is a free one (auto-picks the first free color if the
 * current selection is taken).
 */
function applyTakenColors(selector, takenColors) {
  const picker = document.querySelector(selector);
  if (!picker) return;
  const btns = Array.from(picker.querySelectorAll('.color-btn'));
  const takenSet = new Set(takenColors || []);
  btns.forEach((btn) => {
    const c = btn.dataset.color;
    if (takenSet.has(c)) {
      btn.classList.add('taken');
      btn.classList.remove('selected');
    } else {
      btn.classList.remove('taken');
    }
  });
  // If nothing is selected (all picks were taken), pick first free
  const stillSelected = picker.querySelector('.color-btn.selected:not(.taken)');
  if (!stillSelected) {
    const firstFree = btns.find((b) => !b.classList.contains('taken'));
    if (firstFree) firstFree.classList.add('selected');
  }
}

/* ======= HOME SCREEN ======= */

function wireHomeScreen() {
  const btnHost = document.getElementById('btn-home-host');
  const btnJoin = document.getElementById('btn-home-join');
  if (btnHost) btnHost.addEventListener('click', () => showScreen('create-room'));
  if (btnJoin) btnJoin.addEventListener('click', () => {
    showScreen('join-room');
    // Reset taken-colors picker since user may be retrying with a new code
    applyTakenColors('.join-color-picker', []);
  });
}

/* ======= CREATE ROOM ======= */

function wireCreateRoom() {
  const btnSubmit = document.getElementById('btn-create-submit');
  const btnBack = document.getElementById('btn-back-create');

  if (btnSubmit) btnSubmit.addEventListener('click', async () => {
    const name = document.getElementById('create-name-input')?.value.trim();
    if (!name) { showToast('Please enter your name'); return; }
    const emoji = getSelectedEmoji('.create-emoji-picker');
    const color = getSelectedColor('.create-color-picker');
    try {
      const result = await createRoom(name, emoji, color);
      roomCode = result.roomCode;
      playerIndex = result.playerIndex;
      isHost = true;
      playerNames = [name];
      saveSession();
      setupLobby();
    } catch (err) {
      console.error(err);
      showToast('Failed to create room.');
    }
  });

  if (btnBack) btnBack.addEventListener('click', () => showScreen('home'));
}

/* ======= JOIN ROOM ======= */

let _joinPreviewUnsub = null;
let _lastPreviewedCode = null;

/**
 * Watches a candidate room (entered code) so the color picker dims any
 * already-taken colors live while the user is still on the join screen.
 * Auto-restarts when the typed code changes.
 */
function startJoinPreviewListener(code) {
  if (!code || code.length !== 4) return;
  if (_lastPreviewedCode === code && _joinPreviewUnsub) return;
  stopJoinPreviewListener();
  _lastPreviewedCode = code;
  const playersRef = ref(db, `snl-rooms/${code}/players`);
  const handler = (snap) => {
    const data = snap.val() || {};
    const taken = Object.values(data).map((p) => p && p.color).filter(Boolean);
    applyTakenColors('.join-color-picker', taken);
  };
  onValue(playersRef, handler);
  _joinPreviewUnsub = () => { off(playersRef, 'value', handler); };
}

function stopJoinPreviewListener() {
  if (_joinPreviewUnsub) { _joinPreviewUnsub(); _joinPreviewUnsub = null; }
  _lastPreviewedCode = null;
  applyTakenColors('.join-color-picker', []);
}

function wireJoinRoom() {
  const btnSubmit = document.getElementById('btn-join-submit');
  const btnBack = document.getElementById('btn-back-join');
  const codeInput = document.getElementById('room-code-input');

  // Live preview: as the user types a 4-char code, start listening to that
  // room's players so the color picker dims taken colors in real time.
  if (codeInput) codeInput.addEventListener('input', () => {
    const code = codeInput.value.trim().toUpperCase();
    if (code.length === 4) {
      startJoinPreviewListener(code);
    } else {
      stopJoinPreviewListener();
    }
  });

  if (btnSubmit) btnSubmit.addEventListener('click', async () => {
    const code = document.getElementById('room-code-input')?.value.trim().toUpperCase();
    const name = document.getElementById('join-name-input')?.value.trim();
    if (!code || code.length !== 4) { showToast('Enter a valid 4-character room code'); return; }
    if (!name) { showToast('Please enter your name'); return; }
    const emoji = getSelectedEmoji('.join-emoji-picker');
    const color = getSelectedColor('.join-color-picker');
    try {
      const result = await joinRoom(code, name, emoji, color);
      if (!result.success) { showToast(result.reason || 'Failed to join'); return; }
      roomCode = code;
      playerIndex = result.playerIndex;
      isHost = false;
      saveSession();
      stopJoinPreviewListener();
      setupLobby();
    } catch (err) {
      console.error(err);
      showToast('Failed to join room.');
    }
  });

  if (btnBack) btnBack.addEventListener('click', () => {
    stopJoinPreviewListener();
    showScreen('home');
  });
}

/* ======= LOBBY ======= */

function setupLobby() {
  stopBackgroundMusic(); // Stop music when entering lobby
  showScreen('lobby');

  const codeEl = document.getElementById('lobby-room-code');
  if (codeEl) codeEl.textContent = roomCode;

  const btnStart = document.getElementById('btn-start-online');
  const waiting = document.getElementById('lobby-waiting');
  if (isHost) {
    if (btnStart) btnStart.hidden = false;
    if (waiting) waiting.hidden = true;
  } else {
    if (btnStart) btnStart.hidden = true;
    if (waiting) waiting.hidden = false;
  }
  
  // Re-enable the leave button in case it was disabled from a previous leave attempt
  const btnLeave = document.getElementById('btn-leave-lobby');
  if (btnLeave) btnLeave.disabled = false;
  
  // Set up delegated event listener for remove buttons (only once)
  const playerList = document.getElementById('lobby-player-list');
  if (playerList && !playerList.dataset.removeListenerAdded) {
    playerList.dataset.removeListenerAdded = 'true';
    playerList.addEventListener('click', async (e) => {
      const removeBtn = e.target.closest('.remove-player-btn');
      if (!removeBtn || removeBtn.disabled) return;
      
      const targetIndex = parseInt(removeBtn.dataset.playerIndex, 10);
      const playerName = removeBtn.dataset.playerName;
      
      if (isNaN(targetIndex) || !roomCode) return;
      
      removeBtn.disabled = true;
      try {
        await removePlayer(roomCode, targetIndex);
        showToast(`${playerName} removed from room`);
      } catch (err) {
        console.error('Failed to remove player:', err);
        showToast('Failed to remove player');
        removeBtn.disabled = false;
      }
    });
  }

  setupDisconnectHandler(roomCode, playerIndex)
    .catch((error) => console.warn('Presence setup failed:', error.message));
  if (unsubscribeRoom) unsubscribeRoom();

  unsubscribeRoom = listenRoom(roomCode, {
    onPlayersChange: (players) => {
      // Filter out ghost players (no name) — leftover from stale onDisconnect
      const keys = Object.keys(players).filter((k) => players[k] && players[k].name).sort();
      roomPlayers = players;
      const arr = keys.map((k) => players[k]);
      playerNames = arr.map((p) => p.name || 'Unknown');
      // Pass both the players array and their keys for rendering
      renderLobbyPlayers(arr, keys);
    },
    onStatusChange: async (status, roomSnapshot) => {
      // Only initialize game flow on the FIRST transition to active.
      // Listener fires on every update, but state stays null until startGame runs.
      if (status === 'active' && !isHost && state == null) {
        try {
          const snap = await firebaseRetry(() => get(ref(db, `snl-rooms/${roomCode}`)));
          if (snap.exists()) {
            const d = snap.val();
            if (d.game && d.players) {
              state = deserializeState(d.game, d.players);
              startGame();
            }
          }
        } catch (err) {
          console.error(err);
          showToast('Failed to load game.');
        }
      }
      if (status === 'lobby') {
        state = null;
        _resultsShown = false;
        const lobby = document.getElementById('lobby');
        if (!lobby || lobby.hasAttribute('hidden')) setupLobby();
      }
      if (status === 'ended') {
        if (roomSnapshot?.game?.status === 'finished') {
          if (state?.status === 'finished') handleWin();
        } else if (state) {
          state = { ...state, status: 'finished', winnerIndex: null };
          handleWin();
        }
      }
    },
    onGameUpdate: (gameData, lastMove) => {
      handleRemoteUpdate(gameData, lastMove);
    },
    onRoomDeleted: () => {
      showToast('Host has left. Room closed.', 3000);
      cleanupAndGoHome();
    },
  });
}

function renderLobbyPlayers(playersArr, playerKeys = []) {
  const list = document.getElementById('lobby-player-list');
  if (!list) return;
  list.innerHTML = '';
  const colorDots = {
    red: '🔴', brown: '🟤', yellow: '🟡',
    green: '🟢', blue: '🔵', purple: '🟣',
  };
  playersArr.forEach((player, index) => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.textContent = colorDots[player.color] || '⚪';
    const emojiSpan = document.createElement('span');
    emojiSpan.textContent = player.emoji || '😀';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = player.name || `Player ${index + 1}`;
    nameSpan.style.flex = '1';
    li.appendChild(dot);
    li.appendChild(emojiSpan);
    li.appendChild(nameSpan);
    if (index === 0) {
      const badge = document.createElement('span');
      badge.className = 'host-badge';
      badge.textContent = 'HOST';
      li.appendChild(badge);
    } else if (isHost) {
      // Show remove button for non-host players when current user is host
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-player-btn';
      removeBtn.textContent = '✕';
      removeBtn.title = 'Remove player';
      // Store player info in data attributes for event delegation
      const playerKey = playerKeys[index];
      if (playerKey) {
        const targetIndex = parseInt(playerKey.replace('player_', ''), 10);
        removeBtn.dataset.playerIndex = targetIndex;
        removeBtn.dataset.playerName = player.name;
      }
      li.appendChild(removeBtn);
    }
    list.appendChild(li);
  });
}

function wireLobby() {
  const btnShare = document.getElementById('btn-share-code');
  if (btnShare) btnShare.addEventListener('click', () => {
    if (roomCode) createShareHandler(roomCode, 'Snakes & Ladders MP')();
  });
  
  const btnQR = document.getElementById('btn-qr-code');
  if (btnQR) btnQR.addEventListener('click', () => {
    if (roomCode) showQRCode(roomCode, 'Snakes & Ladders MP');
  });

  const btnStart = document.getElementById('btn-start-online');
  if (btnStart) btnStart.addEventListener('click', async () => {
    if (!isHost || !roomCode) return;
    if (playerNames.length < 2) { showToast('Need at least 2 players'); return; }
    if (playerNames.length > 4) { showToast('Maximum 4 players'); return; }
    try {
      const snap = await firebaseRetry(() => get(ref(db, `snl-rooms/${roomCode}/players`)));
      if (!snap.exists()) { showToast('No players found'); return; }
      const pd = snap.val();
      // Filter out ghost players before starting game
      const keys = Object.keys(pd).filter((k) => pd[k] && pd[k].name).sort();
      roomPlayers = pd;
      const infos = keys.map((k) => ({
        slotKey: k,
        name: pd[k].name || 'Unknown',
        emoji: pd[k].emoji || '😀',
        color: pd[k].color || 'red',
      }));
      const candidate = createGame(infos);
      const validation = validateState(candidate);
      if (!validation.valid) { showToast(`Error: ${validation.error}`); return; }
      const committed = await startGameState(roomCode, serializeState(candidate));
      state = deserializeState(committed, roomPlayers);
      startGame();
    } catch (err) {
      console.error(err);
      showToast('Failed to start game.');
    }
  });

  const btnLeave = document.getElementById('btn-leave-lobby');
  if (btnLeave) btnLeave.addEventListener('click', async () => {
    // Disable button to prevent double-clicks
    btnLeave.disabled = true;
    
    try {
      if (isHost && roomCode) {
        await deleteRoom(roomCode);
      } else if (roomCode && playerIndex != null) {
        // Important: await the leave operation to complete BEFORE cleanup
        // so Firebase actually removes the player node before we navigate away
        await leavePlayer(roomCode, playerIndex);
      }
    } catch (err) {
      console.error('Leave failed:', err);
    } finally {
      cleanupAndGoHome();
    }
  });
}

/* ======= GAMEPLAY ======= */

let _isAnimating = false;
let _lastProcessedRevision = -1;
let _pendingRemoteUpdate = null;

function startGame() {
  _resultsShown = false;
  _isAnimating = false;
  _lastProcessedRevision = state?.revision ?? -1;
  _pendingRemoteUpdate = null;
  showScreen('gameplay');
  
  // Start background music at 15% volume
  startBackgroundMusic();

  const endBtn = document.getElementById('btn-end-game');
  if (endBtn) endBtn.hidden = !isHost;

  // Reset Play Again button for fresh round
  const btnAgain = document.getElementById('btn-play-again');
  if (btnAgain) {
    btnAgain.dataset.hostReady = '';
    btnAgain.dataset.playerReady = '';
    btnAgain.disabled = false;
    btnAgain.textContent = 'Play Again';
  }

  // Build the board
  buildGrid();
  setBoardSkin(getBoardIndex());
  createTokens(state.players.map((p) => p.color || 'red'));
  // Place tokens at initial positions — defer to next two frames so the
  // gameplay screen's layout (just unhidden via showScreen) has fully
  // settled. Without this, getBoundingClientRect for cell 1 can return
  // stale/zero values on first render and tokens end up misaligned at
  // virtual square 0. After Play Again the layout is already stable so
  // it worked, but a fresh game from a fresh load needs the deferral.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      updateTokenSize();
      placeTokens(state.players.map((p) => p.position));
    });
  });

  // Wire roll button (idempotent — re-wires safely)
  const rollBtn = document.getElementById('roll-btn');
  if (rollBtn && !rollBtn._wired) {
    rollBtn._wired = true;
    rollBtn.addEventListener('click', handleRoll);
  }

  // Wire board toggle (idempotent)
  const boardBtn = document.getElementById('board-toggle-btn');
  if (boardBtn && !boardBtn._wired) {
    boardBtn._wired = true;
    boardBtn.addEventListener('click', handleBoardToggle);
  }

  // Mount the standardized voice widget (idempotent — mount once per session)
  if (!voiceWidget) {
    voiceWidget = mountVoiceChat({
      mount: '#voice-widget',
      game: 'snl',
      getRoomCode: () => roomCode,
      getIdentity: () => (playerIndex != null ? `player_${playerIndex}` : null),
      getDisplayName: () => playerNames[playerIndex] || `Player ${playerIndex + 1}`,
      getIdToken: async () => (await authReady).getIdToken(),
      onSpeakers: (ids) => setActiveSpeakers(ids),
      notify: (m) => showToast(m),
    });
  }

  resetDice();
  renderUI();
}

function handleBoardToggle() {
  if (!state) return;
  setBoardSkin((getBoardIndex() + 1) % 3);
}

function localStateIndex() {
  const key = playerIndex == null ? null : `player_${playerIndex}`;
  return state?.players?.findIndex((player) => player.slotKey === key) ?? -1;
}

function renderUI() {
  if (!state) return;
  if (state.status === 'finished') return;

  const cur = state.players[state.currentPlayerIndex];
  setTurn(`${cur?.emoji || ''} ${cur?.name || 'Player'}'s turn`);
  renderPositions(state, localStateIndex());

  // Highlight current player's token
  highlightActiveToken(state.currentPlayerIndex);

  const isMyTurn = state.currentPlayerIndex === localStateIndex();
  const curColor = cur?.color || 'red';
  setRollButtonState(isMyTurn && !_isAnimating, curColor);

  if (isMyTurn) {
    setMessage('Your turn — roll the dice');
  } else {
    setMessage(`Waiting for ${cur?.name || 'opponent'}…`);
  }
}

/* ======= ROLL HANDLER ======= */

async function handleRoll() {
  if (!state || state.status !== 'playing') return;
  if (state.currentPlayerIndex !== localStateIndex()) return;
  if (_isAnimating) return;

  _isAnimating = true;
  setRollButtonState(false, state.players[state.currentPlayerIndex]?.color || 'red');
  setMessage('Rolling...');

  const roll = Math.floor(Math.random() * 6) + 1;

  // Compute outcome locally — drives animations and the new state
  let result;
  try {
    result = applyRoll(state, roll);
  } catch (err) {
    console.error('applyRoll error:', err);
    showToast('Roll failed.');
    _isAnimating = false;
    renderUI();
    return;
  }

  const { outcome, state: newState } = result;
  const moveTimestamp = Date.now();
  const roller = state.players[outcome.by];
  const captured = outcome.capturedPlayer != null ? state.players[outcome.capturedPlayer] : null;
  const lastMove = {
    roller: outcome.by,
    rollerKey: roller.slotKey,
    roll: outcome.roll,
    kind: outcome.kind,
    steps: outcome.steps || 0,
    landing: outcome.landing,
    snakeLadderTo: outcome.snakeLadderTo,
    capturedPlayer: outcome.capturedPlayer,
    capturedPlayerKey: captured?.slotKey,
    win: Boolean(outcome.win),
    timestamp: moveTimestamp,
  };

  let authoritativeState;
  try {
    const committed = await commitMove(roomCode, state.revision, serializeState(newState), lastMove);
    authoritativeState = deserializeState(committed, roomPlayers);
    const validation = validateState(authoritativeState);
    if (!validation.valid) throw new Error(validation.error);
    _lastProcessedRevision = committed.revision;
  } catch (err) {
    console.error('commitMove failed:', err);
    showToast(err.message || 'Sync failed. Try again.');
    _isAnimating = false;
    renderUI();
    drainPendingRemoteUpdate();
    return;
  }

  // Local animation
  playSound('roll');
  throwDiceVisual(roll);
  await new Promise((r) => setTimeout(r, 1150));

  // Drive animations based on outcome kind
  await runOutcomeAnimation(outcome);

  // Adopt the transaction result, including its authoritative revision.
  state = authoritativeState;
  placeTokens(state.players.map((player) => player.position));

  if (state.status === 'finished') {
    handleWin();
    _isAnimating = false;
    return;
  }

  _isAnimating = false;
  renderUI();
  drainPendingRemoteUpdate();
}

/**
 * Animates the visual result of a roll outcome (does not mutate state).
 * Uses a local positions array so we don't have to round-trip through state.
 */
async function runOutcomeAnimation(outcome) {
  // Snapshot positions from current state for animation tracking
  const positions = state.players.map((p) => p.position);
  const idx = outcome.by;
  const tok = document.getElementById(`token${idx}`);

  switch (outcome.kind) {
    case 'overshoot':
      setMessage(`Need exact roll to reach ${TOTAL}.`);
      await new Promise((r) => setTimeout(r, 800));
      break;

    case 'three-sixes':
      if (tok) {
        tok.classList.add('penalty');
        setTimeout(() => tok.classList.remove('penalty'), 1500);
      }
      setMessage(`⚠️ ${state.players[idx].name} rolled three sixes! Turn skipped.`);
      await new Promise((r) => setTimeout(r, 1200));
      break;

    case 'six-bonus':
      if (tok) {
        tok.classList.add('jump');
        setTimeout(() => tok.classList.remove('jump'), 600);
      }
      setMessage(`🎁 ${state.players[idx].name} rolled a 6, roll again!`);
      await new Promise((r) => setTimeout(r, 700));
      break;

    case 'ladder-bonus':
      // Player climbed a ladder and gets bonus turn
      setMessage('');
      await animateSteps(idx, outcome.steps, positions);
      if (outcome.snakeLadderTo != null) {
        await animateSnakeOrLadder(idx, outcome.snakeLadderTo, 'ladder', positions);
      }
      // Animate capture with penalty glow effect
      if (outcome.capturedPlayer != null) {
        const capturedName = state.players[outcome.capturedPlayer].name;
        setMessage(`⚔️ ${capturedName} was captured!`);
        await animateCaptureToken(outcome.capturedPlayer, positions);
        setMessage(`⚔️ ${capturedName} sent back to start! 🪜 Ladder bonus: roll again!`);
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        setMessage(`🪜 Ladder! up to ${outcome.snakeLadderTo} — ${state.players[idx].name} gets a bonus turn!`);
        await new Promise((r) => setTimeout(r, 800));
      }
      break;

    case 'win-with-sixes':
    case 'normal-move':
    case 'win-normal': {
      // Walk to landing, then animate snake/ladder if any
      setMessage('');
      await animateSteps(idx, outcome.steps, positions);
      if (outcome.snakeLadderTo != null) {
        const isLadder = LADDERS[outcome.landing] === outcome.snakeLadderTo;
        const type = isLadder ? 'ladder' : 'snake';
        await animateSnakeOrLadder(idx, outcome.snakeLadderTo, type, positions);
        setMessage(
          isLadder
            ? `🪜 Ladder! up to ${outcome.snakeLadderTo}`
            : `🐍 Snake! down to ${outcome.snakeLadderTo}`,
        );
      }
      // Animate capture with penalty glow effect
      if (outcome.capturedPlayer != null) {
        const capturedName = state.players[outcome.capturedPlayer].name;
        await new Promise((r) => setTimeout(r, 400));
        setMessage(`⚔️ ${capturedName} was captured!`);
        await animateCaptureToken(outcome.capturedPlayer, positions);
        setMessage(`⚔️ ${capturedName} sent back to start!`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      break;
    }
    default:
      break;
  }
}

/* ======= REMOTE UPDATES ======= */

function queueRemoteUpdate(gameData, lastMove) {
  const revision = Number(gameData?.revision ?? -1);
  if (!_pendingRemoteUpdate || revision > Number(_pendingRemoteUpdate.gameData?.revision ?? -1)) {
    _pendingRemoteUpdate = { gameData, lastMove };
  }
}

function drainPendingRemoteUpdate() {
  if (_isAnimating || !_pendingRemoteUpdate) return;
  const pending = _pendingRemoteUpdate;
  _pendingRemoteUpdate = null;
  queueMicrotask(() => handleRemoteUpdate(pending.gameData, pending.lastMove));
}

async function handleRemoteUpdate(gameData, lastMove) {
  if (!gameData || !roomCode || _resultsShown) return;
  const gameplay = document.getElementById('gameplay');
  if (!gameplay || gameplay.hasAttribute('hidden')) return;

  let newState;
  try {
    newState = deserializeState(gameData, roomPlayers);
    const validation = validateState(newState);
    if (!validation.valid) throw new Error(validation.error);
  } catch (error) {
    console.error('Rejected invalid remote state:', error);
    showToast('Received invalid game data. Reconnecting…');
    return;
  }

  if (state && newState.roundId === state.roundId && newState.revision <= state.revision) return;
  if (_isAnimating) { queueRemoteUpdate(gameData, lastMove); return; }

  const isNewRound = state && newState.roundId !== state.roundId;
  const revisionGap = state && !isNewRound && newState.revision > state.revision + 1;
  const moveIsCurrent = lastMove && lastMove.revision === newState.revision;
  const localKey = playerIndex == null ? null : `player_${playerIndex}`;
  const remoteRoller = moveIsCurrent && lastMove.rollerKey !== localKey;

  if (!state || isNewRound || revisionGap || !remoteRoller) {
    state = newState;
    _lastProcessedRevision = Math.max(_lastProcessedRevision, newState.revision);
    placeTokens(state.players.map((player) => player.position));
    if (state.status === 'finished') handleWin();
    else renderUI();
    return;
  }

  const rollerIndex = state.players.findIndex((player) => player.slotKey === lastMove.rollerKey);
  if (rollerIndex < 0) {
    state = newState;
    placeTokens(state.players.map((player) => player.position));
    renderUI();
    return;
  }
  const capturedIndex = lastMove.capturedPlayerKey
    ? state.players.findIndex((player) => player.slotKey === lastMove.capturedPlayerKey)
    : null;

  _isAnimating = true;
  _lastProcessedRevision = newState.revision;
  try {
    setMessage(`${state.players[rollerIndex]?.name || 'Opponent'} rolled ${lastMove.roll}`);
    playSound('roll');
    throwDiceVisual(lastMove.roll);
    await new Promise((resolve) => setTimeout(resolve, 1150));
    await runOutcomeAnimation({
      kind: lastMove.kind,
      by: rollerIndex,
      roll: lastMove.roll,
      steps: lastMove.steps,
      landing: lastMove.landing,
      snakeLadderTo: lastMove.snakeLadderTo,
      capturedPlayer: capturedIndex >= 0 ? capturedIndex : null,
      win: lastMove.win,
    });
    state = newState;
    placeTokens(state.players.map((player) => player.position));
  } catch (error) {
    console.error('Remote animation error:', error);
    state = newState;
    placeTokens(state.players.map((player) => player.position));
  } finally {
    // Unlock before rendering so the new current player's roll button is
    // enabled immediately after the remote animation completes.
    _isAnimating = false;
    if (state.status === 'finished') handleWin();
    else renderUI();
    drainPendingRemoteUpdate();
  }
}

function buildPlayersData() {
  return roomPlayers;
}

/* ======= WIN / RESULTS ======= */

function handleWin() {
  if (_resultsShown) { renderResults(state); showScreen('results'); return; }
  _resultsShown = true;
  
  // Stop background music when game ends
  stopBackgroundMusic();
  
  if (state.winnerIndex != null) {
    try { playSound('win'); } catch (_) {}
    if (typeof confetti === 'function') {
      try {
        confetti({
          particleCount: 250,
          spread: 100,
          origin: { y: 0.6 },
          colors: ['#ffd700', '#ff6b6b', '#51cf66', '#2b6ef6'],
        });
      } catch (_) {}
    }
  }
  try { renderResults(state); } catch (err) { console.error('renderResults error:', err); }
  try { showScreen('results'); } catch (err) { console.error('showScreen error:', err); }
  try { startReadyListener(); } catch (err) { console.error('startReadyListener error:', err); }
}

function renderResults(s) {
  const display = document.getElementById('winner-display');
  const list = document.getElementById('results-list');

  if (display) {
    display.innerHTML = '';
    if (s.winnerIndex != null && s.players[s.winnerIndex]) {
      const winner = s.players[s.winnerIndex];
      const emoji = document.createElement('div');
      emoji.className = 'winner-emoji';
      emoji.textContent = winner.emoji;

      const name = document.createElement('div');
      name.className = 'winner-name';
      name.textContent = `${winner.name} wins!`;

      display.appendChild(emoji);
      display.appendChild(name);
    } else {
      const drawEl = document.createElement('div');
      drawEl.className = 'winner-name';
      drawEl.textContent = 'Game ended — no winner';
      display.appendChild(drawEl);
    }
  }

  if (list) {
    list.innerHTML = '';
    // Sort players by descending position so the leader sits at the top
    const indexed = s.players.map((p, i) => ({ p, i }));
    indexed.sort((a, b) => b.p.position - a.p.position);

    indexed.forEach(({ p, i }, rank) => {
      const li = document.createElement('li');
      if (i === s.winnerIndex) {
        li.style.background = 'rgba(255, 215, 0, 0.25)';
        li.style.borderLeft = '4px solid #ffd700';
      }
      const nameSpan = document.createElement('span');
      const meTag = p.slotKey === `player_${playerIndex}` ? ' (you)' : '';
      const trophy = i === s.winnerIndex ? '🏆 ' : '';
      nameSpan.textContent = `${trophy}${p.emoji} ${p.name}${meTag}`;
      const posSpan = document.createElement('span');
      posSpan.style.color = '#ffd700';
      posSpan.style.fontWeight = '800';
      posSpan.textContent = p.position === TOTAL ? '🎯 Reached 100' : `Square ${p.position}`;
      li.appendChild(nameSpan);
      li.appendChild(posSpan);
      list.appendChild(li);
    });
  }
}

/* ======= END GAME (host only) ======= */

function wireEndGame() {
  const btn = document.getElementById('btn-end-game');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!state || !isHost) return;
    try {
      const committed = await endRoom(roomCode);
      state = deserializeState(committed, roomPlayers);
      handleWin();
    } catch (error) {
      console.error('End round failed:', error);
      showToast('Failed to end the round.');
    }
  });
}

/* ======= PLAY AGAIN / HOME ======= */

function wireResults() {
  const btnAgain = document.getElementById('btn-play-again');
  const btnHome = document.getElementById('btn-home');

  if (btnAgain) btnAgain.addEventListener('click', async () => {
    if (typeof confetti === 'function' && typeof confetti.reset === 'function') {
      try { confetti.reset(); } catch (_) {}
    }
    if (isHost) {
      if (!btnAgain.dataset.hostReady) {
        btnAgain.dataset.hostReady = 'true';
        btnAgain.textContent = '▶ Start New Round';
        if (roomCode) {
          try { await setPlayerReady(roomCode, playerIndex, true); } catch (_) {}
        }
      } else {
        if (window._snlReadyCleanup) window._snlReadyCleanup();
        btnAgain.dataset.hostReady = '';
        btnAgain.dataset.playerReady = '';
        btnAgain.textContent = 'Play Again';
        state = null;
        if (roomCode) { try { await resetRoom(roomCode); } catch (e) { showToast('Failed to reset.'); } }
        setupLobby();
      }
    } else {
      if (roomCode && playerIndex != null) {
        try { await setPlayerReady(roomCode, playerIndex, true); } catch (_) {}
      }
      btnAgain.dataset.playerReady = 'true';
      btnAgain.disabled = true;
      btnAgain.textContent = '✓ Ready';
      showToast('Waiting for host to start new round...');
    }
  });

  if (btnHome) btnHome.addEventListener('click', async () => {
    if (typeof confetti === 'function' && typeof confetti.reset === 'function') {
      try { confetti.reset(); } catch (_) {}
    }
    if (window._snlReadyCleanup) window._snlReadyCleanup();
    if (roomCode) {
      if (playerIndex != null) {
        try { await setPlayerReady(roomCode, playerIndex, 'left'); } catch (_) {}
      }
      if (isHost) {
        try { await deleteRoom(roomCode); } catch (_) {}
      }
    }
    cleanupAndGoHome();
  });
}

function startReadyListener() {
  if (!roomCode) return;
  const btnAgain = document.getElementById('btn-play-again');
  if (btnAgain && !btnAgain.dataset.hostReady && !btnAgain.dataset.playerReady) {
    btnAgain.disabled = false;
    btnAgain.textContent = 'Play Again';
  }
  if (window._snlReadyCleanup) window._snlReadyCleanup();
  const readyRef = ref(db, `snl-rooms/${roomCode}/ready`);
  const handler = (snapshot) => renderReadyIndicators(roomPlayers, snapshot.val() || {});
  onValue(readyRef, handler);
  window._snlReadyCleanup = () => {
    off(readyRef, 'value', handler);
    window._snlReadyCleanup = null;
  };
}

function renderReadyIndicators(players, readyState) {
  const container = document.getElementById('ready-indicators');
  if (!container) return;
  const entries = Object.entries(players || {}).filter(([, player]) => player?.name);
  container.hidden = entries.length === 0;
  container.innerHTML = '';
  entries.forEach(([key, player]) => {
    const dot = document.createElement('div');
    dot.className = 'ready-dot';
    if (readyState[key] === true) dot.classList.add('ready');
    if (readyState[key] === 'left') dot.classList.add('not-ready');
    const circle = document.createElement('div');
    circle.className = 'dot';
    const label = document.createElement('span');
    label.className = 'dot-name';
    label.textContent = player.name;
    dot.append(circle, label);
    container.appendChild(dot);
  });
}

/* ======= SESSION RESTORATION ======= */

async function checkSession() {
  const session = loadSession();
  if (!session?.roomCode || !Number.isInteger(session.playerIndex)) return false;
  try {
    const snap = await firebaseRetry(() => get(ref(db, `snl-rooms/${session.roomCode}`)));
    if (!snap.exists()) { clearSession(); return false; }
    const room = snap.val();
    if (room.schemaVersion !== 2) { clearSession(); return false; }
    const key = `player_${session.playerIndex}`;
    const player = room.players?.[key];
    if (!player || player.uid !== auth.currentUser?.uid) {
      clearSession();
      return false;
    }

    roomCode = session.roomCode;
    playerIndex = session.playerIndex;
    isHost = room.meta?.hostUid === auth.currentUser.uid && key === 'player_0';
    roomPlayers = room.players || {};
    playerNames = Object.keys(roomPlayers).sort().map((slot) => roomPlayers[slot]?.name).filter(Boolean);
    await setupDisconnectHandler(roomCode, playerIndex);

    const effectiveStatus = room.meta?.status === 'ended' || room.game?.status === 'finished'
      ? 'ended'
      : room.game?.status === 'playing' ? 'active' : room.meta?.status;
    if (effectiveStatus === 'lobby') {
      setupLobby();
      return true;
    }
    if ((effectiveStatus === 'active' || effectiveStatus === 'ended') && room.game) {
      state = deserializeState(room.game, roomPlayers);
      if (effectiveStatus === 'ended' && room.game.status !== 'finished') {
        state = { ...state, status: 'finished', winnerIndex: null };
      }
      const validation = validateState(state);
      if (!validation.valid) throw new Error(validation.error);
      setupLobby();
      if (effectiveStatus === 'active') startGame();
      else handleWin();
      return true;
    }
    clearSession();
    return false;
  } catch (error) {
    console.warn('Session restore failed:', error.message);
    showToast('Could not restore the saved game. Check your connection and retry.');
    return false;
  }
}

/* ======= RESPONSIVE LAYOUT — REPOSITION ON ZOOM / RESIZE ======= */

/* Tokens are positioned with absolute pixel coordinates captured via
 * getBoundingClientRect() at the moment placeTokens() ran. CSS-driven
 * layout (board size, grid cells) reflows automatically on zoom or
 * resize, but those captured pixel coordinates do not — so tokens
 * drift relative to the board until something else triggers a redraw.
 *
 * Listening for window.resize and visualViewport.resize covers both
 * window resizing and browser zoom (Chrome/Edge fire visualViewport
 * resize on Ctrl+/Ctrl- zoom). Debounced so it doesn't run mid-drag. */
let _layoutResyncTimer = null;
function syncTokensToLayout() {
  if (!state || !state.players) return;
  // Only meaningful while the gameplay screen is visible
  const gameplayEl = document.getElementById('gameplay');
  if (!gameplayEl || gameplayEl.hasAttribute('hidden')) return;
  updateTokenSize();
  placeTokens(state.players.map((p) => p.position));
}
function scheduleLayoutResync() {
  if (_layoutResyncTimer) clearTimeout(_layoutResyncTimer);
  _layoutResyncTimer = setTimeout(syncTokensToLayout, 120);
}
window.addEventListener('resize', scheduleLayoutResync);
window.addEventListener('orientationchange', scheduleLayoutResync);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', scheduleLayoutResync);
}

/* ======= SERVICE WORKER ======= */

let waitingWorker = null;
let updateAccepted = false;

function setUpdateToastProgress(isUpdating, message = null) {
  const toast = document.getElementById('updateToast');
  const reloadButton = document.getElementById('updateToastReload');
  const laterButton = document.getElementById('updateToastLater');
  const messageElement = document.getElementById('updateToastMessage');
  if (reloadButton) {
    reloadButton.disabled = isUpdating;
    reloadButton.textContent = isUpdating ? 'Updating…' : 'Reload Now';
    reloadButton.style.cursor = isUpdating ? 'wait' : 'pointer';
    reloadButton.style.opacity = isUpdating ? '0.7' : '1';
    reloadButton.toggleAttribute('aria-busy', isUpdating);
  }
  if (laterButton) {
    laterButton.disabled = isUpdating;
    laterButton.style.cursor = isUpdating ? 'wait' : 'pointer';
    laterButton.style.opacity = isUpdating ? '0.7' : '1';
  }
  if (messageElement) messageElement.textContent = message || (isUpdating
    ? 'Applying update… The app will reload automatically.'
    : 'Refresh to get the latest version');
  if (toast) toast.toggleAttribute('aria-busy', isUpdating);
}

window.reloadForUpdate = function() {
  if (updateAccepted) return;
  updateAccepted = true;
  setUpdateToastProgress(true);
  if (!waitingWorker) {
    requestAnimationFrame(() => requestAnimationFrame(() => window.location.reload()));
    return;
  }
  try {
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  } catch (error) {
    updateAccepted = false;
    setUpdateToastProgress(false, 'Update could not start. Please try again.');
    const reloadButton = document.getElementById('updateToastReload');
    if (reloadButton) reloadButton.textContent = 'Try again';
    console.warn('Could not activate the update:', error);
  }
};

window.dismissUpdate = function() {
  const toast = document.getElementById('updateToast');
  if (toast) toast.style.display = 'none';
};

function showUpdateToast(worker) {
  waitingWorker = worker || waitingWorker;
  const toast = document.getElementById('updateToast');
  if (!toast) return;
  toast.style.display = 'block';
  toast.style.animation = 'slideUp 0.4s ease-out';
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateAccepted) window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((registration) => {
      if (registration.waiting && navigator.serviceWorker.controller) {
        showUpdateToast(registration.waiting);
      }
      setInterval(() => registration.update(), 5 * 60 * 1000);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateToast(worker);
          }
        });
      });
    }).catch((error) => console.warn('Service worker registration failed:', error));
  });
}

function wireMuteToggle() {
  const toggle = document.getElementById('mute-toggle');
  if (!toggle) return;
  const render = (muted) => {
    toggle.textContent = muted ? '🔇' : '🔊';
    toggle.setAttribute('aria-pressed', String(muted));
    toggle.setAttribute('aria-label', muted ? 'Unmute game sound' : 'Mute game sound');
  };
  render(isMuted());
  toggle.addEventListener('click', () => render(toggleMute()));
}

/* ======= PWA APP BANNER ======= */

let deferredInstallPrompt = null;

// Capture the install prompt event
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

function showAppBanner() {
  // Check if already shown in this session
  if (sessionStorage.getItem('app-banner-dismissed')) return;
  
  // Remove existing banner if any
  const existing = document.getElementById('app-banner');
  if (existing) existing.remove();
  
  // Detect device type
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const bannerText = isMobile 
    ? 'Better experience in app' 
    : 'Have the app installed?';
  const buttonText = isMobile 
    ? 'Open/Install App' 
    : 'Using App';
  
  // Create banner HTML
  const banner = document.createElement('div');
  banner.id = 'app-banner';
  banner.className = 'app-banner';
  banner.innerHTML = `
    <div class="app-banner-content">
      <span class="app-banner-icon">📱</span>
      <span class="app-banner-text">${bannerText}</span>
      <div class="app-banner-actions">
        <button id="app-banner-open" class="app-banner-btn primary">${buttonText}</button>
        <button id="app-banner-continue" class="app-banner-btn secondary">Continue Here</button>
        <button id="app-banner-close" class="app-banner-btn close" aria-label="Close">×</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(banner);
  
  // Animate in
  setTimeout(() => banner.classList.add('show'), 100);
  
  // Wire buttons
  document.getElementById('app-banner-open')?.addEventListener('click', () => handleOpenApp(isMobile));
  document.getElementById('app-banner-continue')?.addEventListener('click', dismissAppBanner);
  document.getElementById('app-banner-close')?.addEventListener('click', dismissAppBanner);
}

function dismissAppBanner() {
  const banner = document.getElementById('app-banner');
  if (banner) {
    banner.classList.remove('show');
    setTimeout(() => banner.remove(), 300);
  }
  sessionStorage.setItem('app-banner-dismissed', 'true');
}

async function handleOpenApp(isMobile) {
  try {
    // If install prompt is available, show it
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const result = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      
      if (result.outcome === 'accepted') {
        showToast('App installing...');
        dismissAppBanner();
      } else {
        showToast('Continue in browser');
      }
      return;
    }
    
    // Desktop: Different message since we can't auto-open
    if (!isMobile) {
      dismissAppBanner();
      showToast('💡 Tip: Open the app separately from your desktop/start menu', 4000);
      return;
    }
    
    // Mobile: Try to open PWA using custom scheme
    // This will only work if PWA is already installed
    const currentUrl = window.location.href;
    window.location.href = currentUrl.replace('https://', 'web+snl://');
    
    // Wait to see if app opened
    setTimeout(() => {
      // Still here? App didn't open or not installed
      showToast('Install app: Browser menu (⋮) → "Install app"', 3500);
    }, 1000);
    
  } catch (err) {
    console.warn('Failed to open app:', err);
    showToast('Install app: Browser menu (⋮) → "Install app"', 3500);
  }
}

/* ======= INIT ======= */

async function init() {
  wireHomeScreen();
  wireCreateRoom();
  wireJoinRoom();
  wireLobby();
  wireEndGame();
  wireResults();
  wireMuteToggle();
  wireEmojiPicker('.create-emoji-picker');
  wireEmojiPicker('.join-emoji-picker');
  wireColorPicker('.create-color-picker');
  wireColorPicker('.join-color-picker');

  try {
    await authReady;
  } catch (error) {
    console.error('Authentication failed:', error);
    showToast('Unable to connect securely. Check your internet connection.');
    showScreen('home');
    return;
  }

  const linkedCode = new URL(location.href).searchParams.get('room')?.toUpperCase() || null;
  const saved = loadSession();
  if (linkedCode && saved?.roomCode === linkedCode) {
    history.replaceState({}, '', location.pathname);
    if (await checkSession()) return;
  }

  const urlRoomCode = initDeepLinkHandler({
    roomInputId: 'room-code-input',
    joinScreenId: 'join-room',
    gameName: 'Snakes & Ladders MP',
    showScreenFn: showScreen,
  });
  if (urlRoomCode) {
    setTimeout(() => {
      const input = document.getElementById('room-code-input');
      if (input && input.value.length === 4) input.dispatchEvent(new Event('input', { bubbles: true }));
    }, 100);
    return;
  }

  if (!await checkSession()) showScreen('home');
}

init();

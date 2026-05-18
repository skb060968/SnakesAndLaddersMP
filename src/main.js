/* Snakes & Ladders MP — entry point.
 *
 * Wires room flows (create / join / lobby / start / leave / end / play again).
 * Gameplay rendering and dice/animation logic will be added in Step 5.
 */

import { showScreen, showToast } from './platform-ui.js';
import {
  createRoom,
  joinRoom,
  listenRoom,
  setupDisconnectHandler,
  endRoom,
  deleteRoom,
  resetRoom,
  writeGameState,
  firebaseRetry,
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
  playSound,
  setMessage,
  setTurn,
  renderPositions,
  setRollButtonState,
  isMuted,
  toggleMute,
} from './ui.js';
import { db } from './firebase-config.js';
import { ref, get, update, remove, onValue, off } from 'firebase/database';

/* ======= CONSTANTS ======= */

const SESSION_KEY = 'snl_mp_session';

/* ======= STATE ======= */

let state = null;
let roomCode = null;
let playerIndex = null;
let isHost = false;
let playerNames = [];
let unsubscribeRoom = null;
let _resultsShown = false;

/* ======= SESSION PERSISTENCE ======= */

function saveSession() {
  if (roomCode != null && playerIndex != null) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode, playerIndex, isHost }));
    } catch (_) {}
  }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
}
function loadSession() {
  try { const r = localStorage.getItem(SESSION_KEY); return r ? JSON.parse(r) : null; } catch (_) { return null; }
}

function cleanupAndGoHome() {
  if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
  clearSession();
  roomCode = null;
  playerIndex = null;
  isHost = false;
  playerNames = [];
  state = null;
  _resultsShown = false;
  showScreen('online-choice');
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

/* ======= ONLINE CHOICE SCREEN ======= */

function wireOnlineChoice() {
  const btnCreate = document.getElementById('btn-create-room');
  const btnJoin = document.getElementById('btn-join-room');
  if (btnCreate) btnCreate.addEventListener('click', () => showScreen('create-room'));
  if (btnJoin) btnJoin.addEventListener('click', () => showScreen('join-room'));
}

/* ======= CREATE ROOM ======= */

function wireCreateRoom() {
  const btnSubmit = document.getElementById('btn-create-submit');
  const btnBack = document.getElementById('btn-back-create');

  if (btnSubmit) btnSubmit.addEventListener('click', async () => {
    const name = document.getElementById('create-name-input')?.value.trim();
    if (!name) { showToast('Please enter your name'); return; }
    const emoji = getSelectedEmoji('.create-emoji-picker');
    try {
      const result = await createRoom(name, emoji);
      roomCode = result.roomCode;
      playerIndex = result.playerIndex;
      isHost = true;
      playerNames = [name];
      saveSession();
      setupDisconnectHandler(roomCode, playerIndex);
      setupLobby();
    } catch (err) {
      console.error(err);
      showToast('Failed to create room.');
    }
  });

  if (btnBack) btnBack.addEventListener('click', () => showScreen('online-choice'));
}

/* ======= JOIN ROOM ======= */

function wireJoinRoom() {
  const btnSubmit = document.getElementById('btn-join-submit');
  const btnBack = document.getElementById('btn-back-join');

  if (btnSubmit) btnSubmit.addEventListener('click', async () => {
    const code = document.getElementById('room-code-input')?.value.trim().toUpperCase();
    const name = document.getElementById('join-name-input')?.value.trim();
    if (!code || code.length !== 4) { showToast('Enter a valid 4-character room code'); return; }
    if (!name) { showToast('Please enter your name'); return; }
    const emoji = getSelectedEmoji('.join-emoji-picker');
    try {
      const result = await joinRoom(code, name, emoji);
      if (!result.success) { showToast(result.reason || 'Failed to join'); return; }
      roomCode = code;
      playerIndex = result.playerIndex;
      isHost = false;
      saveSession();
      setupDisconnectHandler(roomCode, playerIndex);
      setupLobby();
    } catch (err) {
      console.error(err);
      showToast('Failed to join room.');
    }
  });

  if (btnBack) btnBack.addEventListener('click', () => showScreen('online-choice'));
}

/* ======= LOBBY ======= */

function setupLobby() {
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

  setupDisconnectHandler(roomCode, playerIndex);
  if (unsubscribeRoom) unsubscribeRoom();

  unsubscribeRoom = listenRoom(roomCode, {
    onPlayersChange: (players) => {
      const keys = Object.keys(players).sort();
      const arr = keys.map((k) => players[k]);
      playerNames = arr.map((p) => p.name || 'Unknown');
      renderLobbyPlayers(arr);
    },
    onStatusChange: async (status) => {
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
        setupLobby();
      }
      if (status === 'ended') {
        if (state) {
          state.status = 'finished';
          state.winnerIndex = null;
          renderResults(state);
          showScreen('results');
          startReadyListener();
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

function renderLobbyPlayers(playersArr) {
  const list = document.getElementById('lobby-player-list');
  if (!list) return;
  list.innerHTML = '';
  playersArr.forEach((player, index) => {
    const li = document.createElement('li');
    const emojiSpan = document.createElement('span');
    emojiSpan.textContent = player.emoji || '😀';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = player.name || `Player ${index + 1}`;
    nameSpan.style.flex = '1';
    li.appendChild(emojiSpan);
    li.appendChild(nameSpan);
    if (index === 0) {
      const badge = document.createElement('span');
      badge.className = 'host-badge';
      badge.textContent = 'HOST';
      li.appendChild(badge);
    }
    list.appendChild(li);
  });
}

function wireLobby() {
  const btnShare = document.getElementById('btn-share-code');
  if (btnShare) btnShare.addEventListener('click', async () => {
    if (!roomCode) return;
    const text = `Join my Snakes & Ladders room! Code: ${roomCode}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Snakes & Ladders MP', text, url: location.origin }); return; } catch (_) {}
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${location.origin}`);
      showToast('Room code copied!');
    } catch (_) {
      showToast(`Room code: ${roomCode}`);
    }
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
      const keys = Object.keys(pd).sort();
      const infos = keys.map((k) => ({
        name: pd[k].name || 'Unknown',
        emoji: pd[k].emoji || '😀',
      }));
      state = createGame(infos);
      const validation = validateState(state);
      if (!validation.valid) { showToast(`Error: ${validation.error}`); return; }
      await writeGameState(roomCode, serializeState(state), null);
      startGame();
    } catch (err) {
      console.error(err);
      showToast('Failed to start game.');
    }
  });

  const btnLeave = document.getElementById('btn-leave-lobby');
  if (btnLeave) btnLeave.addEventListener('click', async () => {
    if (isHost && roomCode) {
      try { await deleteRoom(roomCode); } catch (_) {}
    } else if (roomCode && playerIndex != null) {
      try { await remove(ref(db, `snl-rooms/${roomCode}/players/player_${playerIndex}`)); } catch (_) {}
    }
    cleanupAndGoHome();
  });
}

/* ======= GAMEPLAY ======= */

let _isAnimating = false;
let _lastProcessedMoveTimestamp = 0;

function startGame() {
  _resultsShown = false;
  _isAnimating = false;
  _lastProcessedMoveTimestamp = 0;
  showScreen('gameplay');

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
  setBoardSkin(state.boardIndex || 0);
  createTokens(state.players.length);
  // Place tokens at initial positions (1)
  placeTokens(state.players.map((p) => p.position));

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

  resetDice();
  renderUI();
}

async function handleBoardToggle() {
  if (!state || !roomCode) return;
  const next = (getBoardIndex() + 1) % 3;
  setBoardSkin(next);
  state = { ...state, boardIndex: next };
  // Sync to Firebase so others see the change
  try {
    await update(ref(db, `snl-rooms/${roomCode}/game/boardIndex`), null);
    await update(ref(db, `snl-rooms/${roomCode}/game`), { boardIndex: next });
  } catch (_) {}
}

function renderUI() {
  if (!state) return;
  if (state.status === 'finished') return;

  const cur = state.players[state.currentPlayerIndex];
  setTurn(`${cur?.emoji || ''} ${cur?.name || 'Player'}'s turn`);
  renderPositions(state, playerIndex);

  // Highlight current player's token
  highlightActiveToken(state.currentPlayerIndex);

  const isMyTurn = state.currentPlayerIndex === playerIndex;
  setRollButtonState(isMyTurn && !_isAnimating, state.currentPlayerIndex);

  if (isMyTurn) {
    setMessage('Your turn — roll the dice');
  } else {
    setMessage(`Waiting for ${cur?.name || 'opponent'}…`);
  }
}

/* ======= ROLL HANDLER ======= */

async function handleRoll() {
  if (!state || state.status !== 'playing') return;
  if (state.currentPlayerIndex !== playerIndex) return;
  if (_isAnimating) return;

  _isAnimating = true;
  setRollButtonState(false, state.currentPlayerIndex);
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

  // Build a single lastMove descriptor that contains everything opponents
  // need to replay this turn's animations.
  const lastMove = {
    roller: outcome.by,
    roll: outcome.roll,
    kind: outcome.kind,
    steps: outcome.steps || 0,
    landing: outcome.landing != null ? outcome.landing : null,
    snakeLadderTo: outcome.snakeLadderTo != null ? outcome.snakeLadderTo : null,
    win: !!outcome.win,
    timestamp: moveTimestamp,
  };

  // Mark this timestamp processed BEFORE writing — so the listener echo
  // for our own move is recognized and doesn't replay the animation locally.
  _lastProcessedMoveTimestamp = moveTimestamp;

  // Single write: authoritative new state + lastMove descriptor.
  try {
    await writeGameState(roomCode, serializeState(newState), lastMove);
  } catch (err) {
    console.error('writeGameState failed:', err);
    showToast('Sync failed. Try again.');
    _isAnimating = false;
    renderUI();
    return;
  }

  // Local animation
  playSound('roll');
  throwDiceVisual(roll);
  await new Promise((r) => setTimeout(r, 1150));

  // Drive animations based on outcome kind
  await runOutcomeAnimation(outcome);

  // Update local state to the new state
  state = newState;

  if (state.status === 'finished') {
    handleWin();
    _isAnimating = false;
    return;
  }

  _isAnimating = false;
  renderUI();
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
      break;
    }
    default:
      break;
  }
}

/* ======= REMOTE UPDATES ======= */

async function handleRemoteUpdate(gameData, lastMove) {
  if (!gameData || !roomCode) return;
  if (_resultsShown) return;
  if (_isAnimating) return;

  // Don't process gameplay updates until our gameplay screen is initialized
  // (startGame() must have run to create tokens and grid).
  const gameplayEl = document.getElementById('gameplay');
  if (!gameplayEl || gameplayEl.hasAttribute('hidden')) {
    return;
  }

  // Skip echoes of our own moves — we already animated locally
  if (lastMove && lastMove.timestamp === _lastProcessedMoveTimestamp) {
    // Local state already current, just refresh authoritative state from Firebase
    const playersData = buildPlayersData();
    state = deserializeState(gameData, playersData);
    if (state.status === 'finished') {
      handleWin();
    } else {
      renderUI();
    }
    return;
  }

  const playersData = buildPlayersData();
  const newState = deserializeState(gameData, playersData);

  // Detect a remote move via lastMove descriptor
  if (lastMove && lastMove.roller != null && lastMove.roller !== playerIndex) {
    _isAnimating = true;
    _lastProcessedMoveTimestamp = lastMove.timestamp || 0;

    try {
      // Local positions snapshot for animation
      const positions = state ? state.players.map((p) => p.position) : newState.players.map((p) => p.position);

      // Dice phase
      setMessage(`${state?.players[lastMove.roller]?.name || 'Opponent'} rolled ${lastMove.roll}`);
      playSound('roll');
      throwDiceVisual(lastMove.roll);
      await new Promise((r) => setTimeout(r, 1150));

      // Animate based on kind
      await runOutcomeAnimation({
        kind: lastMove.kind,
        by: lastMove.roller,
        roll: lastMove.roll,
        steps: lastMove.steps,
        landing: lastMove.landing,
        snakeLadderTo: lastMove.snakeLadderTo,
        win: lastMove.win,
      });

      state = newState;

      if (state.status === 'finished') {
        handleWin();
        return;
      }
      renderUI();
    } catch (err) {
      console.error('Remote animation error:', err);
      // Recover: jump straight to the new state without animation
      state = newState;
      if (state.status === 'finished') {
        handleWin();
        return;
      }
      placeTokens(state.players.map((p) => p.position));
      renderUI();
    } finally {
      _isAnimating = false;
    }
    return;
  }

  // Generic update (e.g. board skin change, lobby->game start sync)
  state = newState;

  // Sync board skin if it differs from local
  if (state.boardIndex != null && state.boardIndex !== getBoardIndex()) {
    setBoardSkin(state.boardIndex);
  }

  if (state.status === 'finished') {
    handleWin();
    return;
  }
  renderUI();
}

function buildPlayersData() {
  const playersData = {};
  playerNames.forEach((name, i) => {
    playersData[`player_${i}`] = {
      name,
      emoji: state ? state.players[i]?.emoji || '😀' : '😀',
    };
  });
  return playersData;
}

/* ======= WIN / RESULTS (Step 6 will polish this) ======= */

function handleWin() {
  if (_resultsShown) { renderResults(state); showScreen('results'); return; }
  _resultsShown = true;
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
      const meTag = i === playerIndex ? ' (you)' : '';
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
    if (!state) return;
    state.status = 'finished';
    state.winnerIndex = null;
    if (roomCode) { try { await endRoom(roomCode); } catch (_) {} }
    renderResults(state);
    showScreen('results');
    startReadyListener();
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
          try { await update(ref(db, `snl-rooms/${roomCode}/ready`), { [`player_${playerIndex}`]: true }); } catch (_) {}
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
        try { await update(ref(db, `snl-rooms/${roomCode}/ready`), { [`player_${playerIndex}`]: true }); } catch (_) {}
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
        try { await update(ref(db, `snl-rooms/${roomCode}/ready`), { [`player_${playerIndex}`]: 'left' }); } catch (_) {}
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
  const handler = (snap) => {
    const data = snap.val() || {};
    const ready = Object.keys(data).filter((k) => data[k] === true)
      .map((k) => parseInt(k.replace('player_', ''), 10))
      .filter((n) => !isNaN(n));
    const left = Object.keys(data).filter((k) => data[k] === 'left')
      .map((k) => parseInt(k.replace('player_', ''), 10))
      .filter((n) => !isNaN(n));
    renderReadyIndicators(playerNames, ready, left);
  };
  onValue(readyRef, handler);
  window._snlReadyCleanup = () => { off(readyRef, 'value', handler); window._snlReadyCleanup = null; };
}

function renderReadyIndicators(names, readyArr, leftArr) {
  const container = document.getElementById('ready-indicators');
  if (!container) return;
  container.hidden = false;
  container.innerHTML = '';
  const readySet = new Set(readyArr);
  const leftSet = new Set(leftArr);
  names.forEach((name, i) => {
    const dot = document.createElement('div');
    dot.className = 'ready-dot';
    if (readySet.has(i)) dot.classList.add('ready');
    if (leftSet.has(i)) dot.classList.add('not-ready');
    const circle = document.createElement('div');
    circle.className = 'dot';
    const label = document.createElement('span');
    label.className = 'dot-name';
    label.textContent = name;
    dot.appendChild(circle);
    dot.appendChild(label);
    container.appendChild(dot);
  });
}

/* ======= SESSION RESTORATION ======= */

async function checkSession() {
  const session = loadSession();
  if (!session) return false;
  try {
    const snap = await firebaseRetry(() => get(ref(db, `snl-rooms/${session.roomCode}`)));
    if (!snap.exists()) { clearSession(); return false; }
    const d = snap.val();
    const status = d.meta?.status;
    if (status === 'ended') { clearSession(); return false; }

    roomCode = session.roomCode;
    playerIndex = session.playerIndex;
    isHost = session.isHost;
    if (d.players) {
      const keys = Object.keys(d.players).sort();
      playerNames = keys.map((k) => d.players[k].name || 'Unknown');
    }
    try { await update(ref(db, `snl-rooms/${roomCode}/players/player_${playerIndex}`), { connected: true }); } catch (_) {}

    if (status === 'lobby') { setupLobby(); return true; }
    if (status === 'active' && d.game) {
      state = deserializeState(d.game, d.players);
      setupDisconnectHandler(roomCode, playerIndex);
      if (unsubscribeRoom) unsubscribeRoom();
      unsubscribeRoom = listenRoom(roomCode, {
        onPlayersChange: (players) => {
          const keys = Object.keys(players).sort();
          playerNames = keys.map((k) => players[k].name || 'Unknown');
        },
        onStatusChange: async (s) => {
          if (s === 'lobby') { state = null; _resultsShown = false; setupLobby(); }
          if (s === 'ended' && state) {
            state.status = 'finished';
            state.winnerIndex = null;
            renderResults(state);
            showScreen('results');
            startReadyListener();
          }
        },
        onGameUpdate: (gd, lm) => { handleRemoteUpdate(gd, lm); },
        onRoomDeleted: () => { showToast('Host has left. Room closed.', 3000); cleanupAndGoHome(); },
      });
      startGame();
      return true;
    }
    clearSession();
    return false;
  } catch (err) {
    console.warn('Session restore failed:', err.message);
    clearSession();
    return false;
  }
}

/* ======= SERVICE WORKER ======= */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      console.log('SW registered');
      if (reg.waiting) showUpdateToast(reg);
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (installing) {
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateToast(reg);
            }
          });
        }
      });
    } catch (err) {
      console.warn('SW registration failed:', err.message);
    }
  });
}

function showUpdateToast(reg) {
  const toast = document.getElementById('update-toast');
  const btn = document.getElementById('update-refresh-btn');
  if (!toast) return;
  toast.hidden = false;
  if (btn && !btn._listenerAdded) {
    btn._listenerAdded = true;
    btn.addEventListener('click', () => {
      toast.hidden = true;
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload();
      });
    });
  }
}

function wireMuteToggle() {
  const toggle = document.getElementById('mute-toggle');
  if (!toggle) return;
  toggle.checked = isMuted();
  toggle.addEventListener('change', () => toggleMute());
}

/* ======= INIT ======= */

async function init() {
  wireOnlineChoice();
  wireCreateRoom();
  wireJoinRoom();
  wireLobby();
  wireEndGame();
  wireResults();
  wireMuteToggle();
  wireEmojiPicker('.create-emoji-picker');
  wireEmojiPicker('.join-emoji-picker');

  // Try restoring an existing session before showing the choice screen
  const restored = await checkSession();
  if (!restored) showScreen('online-choice');
}

init();

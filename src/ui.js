/**
 * Snakes & Ladders MP — UI Module
 *
 * DOM rendering + animations for the gameplay screen.
 * Pure rendering (no game logic, no Firebase).
 *
 * Exposes:
 *   - buildGrid()                — creates the 10×10 grid with cell numbers
 *   - setBoardSkin(index)        — switches board background
 *   - createTokens(playerCount)  — adds N token DOM elements
 *   - placeTokens(positions)     — moves tokens to their squares
 *   - updateTokenSize()          — re-measures cell size for responsive tokens
 *   - throwDiceVisual(value)     — animates the 3D dice cube
 *   - playSound(name)            — fires audio
 *   - animateSteps(...)          — moves a token N squares with hop animation
 *   - animateSnakeOrLadder(...)  — slide-jump along a snake/ladder path
 *   - highlightActiveToken(idx)  — pulses the current player's token
 *   - setMessage(text)           — sets the message line
 *   - setTurn(text)              — sets the turn header
 *   - renderPositions(state, localIdx) — fills the positions list
 */

import { BOARD_SIZE, TOTAL } from './engine.js';
import * as tokens3d from './tokens3d.js';

const BOARD_SKINS = [
  '/images/board2.png',
  '/images/board.png',
  '/images/board1.png',
];

/* ======= AUDIO ======= */

const soundFiles = {
  roll: '/sounds/dice-roll.mp3',
  move: '/sounds/move.mp3',
  snake: '/sounds/snake.mp3',
  ladder: '/sounds/ladder.mp3',
  win: '/sounds/win.mp3',
  music: '/sounds/music.mp3',
};

let audioCtx = null;
const audioBuffers = {};
let audioUnlocked = false;
let _muted = false;

const MUTE_KEY = 'snl_mp_muted';
try {
  const v = localStorage.getItem(MUTE_KEY);
  if (v === '1') _muted = true;
} catch (_) {}

/* ======= BACKGROUND MUSIC ======= */

let backgroundMusic = null;
let backgroundMusicWanted = false;
let backgroundMusicVolume = 0.10;

function pauseBackgroundMusic() {
  try { backgroundMusic?.pause(); } catch (_) {}
}

function resumeBackgroundMusic() {
  if (!backgroundMusicWanted || _muted) return;
  if (!backgroundMusic) {
    startBackgroundMusic();
    return;
  }
  if (backgroundMusic.paused) backgroundMusic.play().catch(() => {});
}

export function startBackgroundMusic() {
  backgroundMusicWanted = true;
  if (_muted) return;
  if (backgroundMusic) {
    backgroundMusic.play().catch(() => {});
    return;
  }
  try {
    backgroundMusic = new Audio(soundFiles.music);
    backgroundMusic.loop = true;
    backgroundMusic.volume = backgroundMusicVolume;
    backgroundMusic.play().catch(() => {});
  } catch (_) {
    backgroundMusic = null;
  }
}

export function stopBackgroundMusic() {
  backgroundMusicWanted = false;
  if (!backgroundMusic) return;
  try {
    backgroundMusic.pause();
    backgroundMusic.currentTime = 0;
  } catch (_) {}
  backgroundMusic = null;
}

export function setBackgroundMusicVolume(volume) {
  backgroundMusicVolume = Math.max(0, Math.min(1, volume));
  if (backgroundMusic) backgroundMusic.volume = backgroundMusicVolume;
}

export { pauseBackgroundMusic, resumeBackgroundMusic };

/* ======= MUTE CONTROLS ======= */

export function isMuted() { return _muted; }

export function setMuted(value) {
  _muted = !!value;
  try { localStorage.setItem(MUTE_KEY, _muted ? '1' : '0'); } catch (_) {}
  
  // Pause or resume background music based on mute state
  if (_muted) {
    pauseBackgroundMusic();
  } else {
    resumeBackgroundMusic();
  }
}

export function toggleMute() {
  setMuted(!_muted);
  return _muted;
}

function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    resumeBackgroundMusic();
    Object.entries(soundFiles).forEach(([name, url]) => {
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((b) => audioCtx.decodeAudioData(b))
        .then((d) => { audioBuffers[name] = d; })
        .catch(() => {});
    });
  } catch (_) {
    audioCtx = null;
  }
}

['click', 'touchstart', 'keydown'].forEach((evt) => {
  document.addEventListener(evt, unlockAudio, { once: true });
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') pauseBackgroundMusic();
  else resumeBackgroundMusic();
});

export function playSound(name) {
  if (_muted) return;
  if (audioCtx && audioBuffers[name]) {
    const src = audioCtx.createBufferSource();
    src.buffer = audioBuffers[name];
    src.connect(audioCtx.destination);
    src.start(0);
    return;
  }
  try {
    const a = new Audio(soundFiles[name]);
    a.play().catch(() => {});
  } catch (_) {}
}

/* ======= BOARD SKIN ======= */

const BOARD_SKIN_KEY = 'snl_mp_board_skin';
let currentBoardIndex = 0;
try {
  const saved = Number.parseInt(localStorage.getItem(BOARD_SKIN_KEY), 10);
  if (Number.isInteger(saved)) currentBoardIndex = ((saved % BOARD_SKINS.length) + BOARD_SKINS.length) % BOARD_SKINS.length;
} catch (_) {}

export function setBoardSkin(index) {
  currentBoardIndex = ((index % BOARD_SKINS.length) + BOARD_SKINS.length) % BOARD_SKINS.length;
  try { localStorage.setItem(BOARD_SKIN_KEY, String(currentBoardIndex)); } catch (_) {}
  const boardImg = document.getElementById('board-img');
  if (!boardImg) return;
  boardImg.src = BOARD_SKINS[currentBoardIndex];
  if (boardImg.complete) {
    requestAnimationFrame(() => {
      updateTokenSize();
      const positions = readCurrentPositions();
      if (positions) placeTokens(positions);
    });
  } else {
    boardImg.addEventListener('load', () => {
      requestAnimationFrame(() => {
        updateTokenSize();
        const positions = readCurrentPositions();
        if (positions) placeTokens(positions);
      });
    }, { once: true });
  }
}

export function getBoardIndex() { return currentBoardIndex; }

/** Last positions handed to placeTokens — re-applied after a board skin change. */
let _lastPositions = null;
function readCurrentPositions() {
  return _lastPositions ? _lastPositions.slice() : null;
}

/* ======= GRID ======= */

export function buildGrid() {
  const gridEl = document.getElementById('grid');
  if (!gridEl) return;
  gridEl.innerHTML = '';
  for (let i = 0; i < TOTAL; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    gridEl.appendChild(cell);
  }
  const elems = Array.from(gridEl.children);
  elems.forEach((el, idx) => {
    const rowFromTop = Math.floor(idx / BOARD_SIZE);
    const colFromLeft = idx % BOARD_SIZE;
    const rowFromBottom = BOARD_SIZE - 1 - rowFromTop;
    let cellInRow;
    if (rowFromBottom % 2 === 0) {
      cellInRow = colFromLeft;
    } else {
      cellInRow = BOARD_SIZE - 1 - colFromLeft;
    }
    const cellNumber = rowFromBottom * BOARD_SIZE + (cellInRow + 1);
    el.dataset.cell = cellNumber;
  });
  requestAnimationFrame(updateTokenSize);
}

let _tokenSizeRaf = null;
export function updateTokenSize() {
  if (_tokenSizeRaf) cancelAnimationFrame(_tokenSizeRaf);
  _tokenSizeRaf = requestAnimationFrame(() => {
    const gridEl = document.getElementById('grid');
    if (!gridEl) return;
    const cell = gridEl.querySelector('.cell');
    if (!cell) return;
    const rect = cell.getBoundingClientRect();
    // Slightly smaller fraction so 4 tokens (2x2 grid) fit cleanly inside one cell.
    const fraction = 0.48;
    const raw = rect.width * fraction;
    const size = Math.max(10, Math.min(48, Math.round(raw)));
    document.documentElement.style.setProperty('--token-size', `${size}px`);
  });
}

function getCellCenter(cellNumber) {
  const gridEl = document.getElementById('grid');
  const wrapper = document.getElementById('board-wrapper');
  if (!gridEl || !wrapper) return { x: 0, y: 0 };
  const cell = gridEl.querySelector(`[data-cell="${cellNumber}"]`);
  const wrapRect = wrapper.getBoundingClientRect();
  if (!cell) return { x: wrapRect.width / 2, y: wrapRect.height / 2 };
  const cellRect = cell.getBoundingClientRect();
  return {
    x: cellRect.left - wrapRect.left + cellRect.width / 2,
    y: cellRect.top - wrapRect.top + cellRect.height / 2,
  };
}

/* ======= TOKENS ======= */

/**
 * Creates N 3D pawns (idx 0..N-1) on the token layer over #board-wrapper.
 * Idempotent — replaces any existing pawns.
 * @param {string[]} colors — array of color ids per player ('red'|'brown'|...)
 */
export function createTokens(colors) {
  const wrapper = document.getElementById('board-wrapper');
  if (!wrapper) return;
  wrapper.querySelectorAll('.token').forEach((t) => t.remove());   // legacy DOM tokens
  if (!tokens3d.mount(wrapper)) return;
  tokens3d.setTokens(colors.map((c) => c || 'red'));
  _lastPositions = colors.map(() => 0);
}

function currentTokenSize() {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--token-size')) || 22;
}

/**
 * Pixel centre (wrapper-relative) for every token given a positions array,
 * including the 2/3/4 stacking offsets for tokens sharing a square.
 */
function computeTokenTargets(positions) {
  const tokenSize = currentTokenSize();
  // Half-step offset: ~38% of token size keeps them touching but distinct
  const d = tokenSize * 0.38;

  // Group ALL players (including pen players at position 0) by cell so that
  // tokens stacked at virtual square 0 also receive 2/3/4-token offsets.
  const cellGroups = new Map(); // cell -> [playerIdx,...]
  positions.forEach((pos, i) => {
    const key = pos < 1 ? 0 : pos;
    if (!cellGroups.has(key)) cellGroups.set(key, []);
    cellGroups.get(key).push(i);
  });

  // Virtual square 0 centre: one cell-width to the left of square 1.
  let virtualZeroCenter = null;
  if (cellGroups.has(0)) {
    const c1 = getCellCenter(1);
    const gridEl = document.getElementById('grid');
    const cell1 = gridEl ? gridEl.querySelector('[data-cell="1"]') : null;
    const cellW = cell1 ? cell1.getBoundingClientRect().width : 0;
    virtualZeroCenter = { x: c1.x - cellW, y: c1.y };
  }

  return positions.map((pos, i) => {
    const groupKey = pos < 1 ? 0 : pos;
    const center = groupKey === 0 ? virtualZeroCenter : getCellCenter(pos);
    if (!center) return null;
    const group = cellGroups.get(groupKey) || [i];
    const idxInGroup = group.indexOf(i);
    const groupSize = group.length;
    let dx = 0, dy = 0;
    if (groupSize === 2) {
      dx = idxInGroup === 0 ? -d : d;
    } else if (groupSize === 3) {
      const offsets = [{ x: -d, y: -d * 0.6 }, { x: d, y: -d * 0.6 }, { x: 0, y: d * 0.7 }];
      dx = offsets[idxInGroup].x;
      dy = offsets[idxInGroup].y;
    } else if (groupSize >= 4) {
      const offsets = [
        { x: -d, y: -d },
        { x:  d, y: -d },
        { x: -d, y:  d },
        { x:  d, y:  d },
      ];
      dx = offsets[idxInGroup].x;
      dy = offsets[idxInGroup].y;
    }
    return { x: center.x + dx, y: center.y + dy };
  });
}

/**
 * Places all tokens at their current positions. Multiple tokens stacked on
 * the same square are arranged compactly so they all stay visible inside
 * the cell:
 *   - 2 tokens: side-by-side (left, right)
 *   - 3 tokens: triangle (2 on top, 1 below center)
 *   - 4 tokens: 2×2 grid
 * Offsets scale with the cell size so they fit any board zoom.
 *
 * Tokens with position === 0 are placed at "virtual square 0" — one cell-width
 * to the left of square 1. They appear there from game start and hop onto the
 * board with their first roll. All tokens with position 0 are stacked together
 * at virtual square 0 using the same group offset logic as on-board cells.
 *
 * Snaps every pawn into place. Pass `hopIdx` to make that one pawn hop to its
 * new square (260 ms arc) while any others whose stacking changed glide over.
 *
 * @param {number[]} positions — array of position numbers per player
 * @param {{hopIdx?: number}} [opts]
 * @returns {Promise<void>} resolves when the hop (if any) lands
 */
export function placeTokens(positions, opts = {}) {
  const wrapper = document.getElementById('board-wrapper');
  if (!wrapper) return Promise.resolve();
  const tokenSize = currentTokenSize();
  tokens3d.setTokenSize(tokenSize);
  _lastPositions = positions.slice();

  const targets = computeTokenTargets(positions);
  let hop = Promise.resolve();
  targets.forEach((t, i) => {
    if (!t) return;
    if (opts.hopIdx === i) {
      hop = tokens3d.moveToken(i, t.x, t.y, { duration: 260, hop: tokenSize * 0.9 });
    } else if (opts.hopIdx != null) {
      tokens3d.moveToken(i, t.x, t.y, { duration: 200 });
    } else {
      tokens3d.moveToken(i, t.x, t.y);
    }
  });
  return hop;
}

export function highlightActiveToken(activeIdx) {
  tokens3d.setActiveToken(activeIdx);
}

/**
 * One-off token feedback used by main.js for outcomes that don't move the
 * token: 'penalty' (three sixes) or 'jump' (rolled a six).
 * @returns {Promise<void>}
 */
export function setTokenEffect(idx, kind) {
  return tokens3d.playEffect(idx, kind);
}

/* ======= DICE ======= */

const faceRotations = {
  1: { x: 0, y: 0 },
  2: { x: 0, y: -90 },
  3: { x: 0, y: 180 },
  4: { x: 0, y: 90 },
  5: { x: -90, y: 0 },
  6: { x: 90, y: 0 },
};

export function throwDiceVisual(finalValue) {
  const diceCube = document.getElementById('dice-cube');
  if (!diceCube) return;
  const extra = 360 * 3;
  const rot = faceRotations[finalValue] || { x: 0, y: 0 };
  diceCube.style.transition = 'transform 360ms cubic-bezier(.33,.9,.28,1)';
  const randX = Math.random() * 720 - 360;
  const randY = Math.random() * 720 - 360;
  diceCube.style.transform = `translateY(-80px) rotateX(${randX}deg) rotateY(${randY}deg)`;
  setTimeout(() => {
    diceCube.style.transition = 'transform 720ms cubic-bezier(.2,.9,.2,1)';
    diceCube.style.transform = `translateY(0px) rotateX(${extra + rot.x}deg) rotateY(${extra + rot.y}deg)`;
  }, 360);
}

export function resetDice() {
  const diceCube = document.getElementById('dice-cube');
  if (diceCube) diceCube.style.transform = 'none';
}

/* ======= TOKEN ANIMATION ======= */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Animates a token stepping forward N squares one at a time (one hop every
 * 300 ms, move sound per hop). Tokens at position 0 hop onto square 1 like any
 * other step. Mutates currentPositions — caller syncs engine state.
 * @returns {Promise<void>}
 */
export async function animateSteps(playerIdx, steps, currentPositions) {
  if (steps <= 0) return;
  for (let s = 0; s < steps; s += 1) {
    currentPositions[playerIdx] = Math.min(TOTAL, currentPositions[playerIdx] + 1);
    playSound('move');
    await placeTokens(currentPositions, { hopIdx: playerIdx });
    await wait(40);
  }
  // The final hop onto 100 gets a short settle before handleWin swaps screens.
  if (currentPositions[playerIdx] === TOTAL) await wait(320);
}

/**
 * Snake or ladder: 500 ms hit cue (red ring + shake / gold ring + bounce), then
 * the token arcs from its square to the target square and settles into its
 * stacking slot there.
 * @param {'snake'|'ladder'} type
 * @returns {Promise<void>}
 */
export async function animateSnakeOrLadder(playerIdx, targetCell, type, currentPositions) {
  playSound(type === 'ladder' ? 'ladder' : 'snake');
  await tokens3d.playEffect(playerIdx, type === 'snake' ? 'snake-hit' : 'ladder-hit');

  const tokenSize = currentTokenSize();
  currentPositions[playerIdx] = targetCell;
  _lastPositions = currentPositions.slice();
  const targets = computeTokenTargets(currentPositions);
  targets.forEach((t, i) => {
    if (!t || i === playerIdx) return;
    tokens3d.moveToken(i, t.x, t.y, { duration: 200 });
  });
  const dest = targets[playerIdx];
  if (dest) await tokens3d.moveToken(playerIdx, dest.x, dest.y, { duration: 440, hop: tokenSize * 1.2 });
}

/**
 * Captured token: red ring flash while it flies back to the start pen.
 * @param {number} capturedPlayerIdx
 * @param {number[]} currentPositions
 * @returns {Promise<void>}
 */
export async function animateCaptureToken(capturedPlayerIdx, currentPositions) {
  if (currentPositions[capturedPlayerIdx] === 0) return;   // already at start
  const tokenSize = currentTokenSize();
  const glow = tokens3d.playEffect(capturedPlayerIdx, 'penalty');

  currentPositions[capturedPlayerIdx] = 0;
  _lastPositions = currentPositions.slice();
  const targets = computeTokenTargets(currentPositions);
  targets.forEach((t, i) => {
    if (!t || i === capturedPlayerIdx) return;
    tokens3d.moveToken(i, t.x, t.y, { duration: 200 });
  });
  const dest = targets[capturedPlayerIdx];
  if (dest) await tokens3d.moveToken(capturedPlayerIdx, dest.x, dest.y, { duration: 750, hop: tokenSize * 1.4 });
  await glow;
}

/* ======= MESSAGE / TURN / POSITIONS ======= */

export function setMessage(text) {
  const el = document.getElementById('message');
  if (el) el.textContent = text || '';
}

export function setTurn(text) {
  const el = document.getElementById('turn');
  if (el) el.textContent = text || '';
}

export /**
 * @param {object} state
 * @param {number} localIdx
 * @param {Set<string>} [offlineKeys] slot keys presence currently reports as offline
 */
function renderPositions(state, localIdx, offlineKeys) {
  const el = document.getElementById('positions');
  if (!el) return;
  const offline = offlineKeys instanceof Set ? offlineKeys : new Set();
  el.innerHTML = '';
  el.className = `positions players-${state.players.length}`;
  // Map color ids to dot emojis (visual cue in the player list)
  const colorDots = {
    red: '🔴', brown: '🟤', yellow: '🟡',
    green: '🟢', blue: '🔵', purple: '🟣',
  };
  state.players.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'player-row';
    if (p.slotKey) row.dataset.slot = p.slotKey;
    const isMe = i === localIdx;
    const isCurrent = i === state.currentPlayerIndex;
    const dot = colorDots[p.color] || '⚪';
    const meTag = isMe ? '👉🏻' : '';
    const label = document.createElement('span');
    label.className = 'player-row-label';
    label.textContent = `${meTag} ${dot} ${p.emoji} ${p.name}: ${p.position}`;
    const speaker = document.createElement('span');
    speaker.className = 'speaker-indicator';
    speaker.setAttribute('aria-hidden', 'true');
    speaker.textContent = '🎙️';
    row.append(label, speaker);
    // Presence cue: a player who has dropped off the network stays in the game
    // (quitting mid-game isn't allowed) so flag them rather than hiding them.
    if (p.slotKey && offline.has(p.slotKey)) {
      row.classList.add('disconnected');
      const off = document.createElement('span');
      off.className = 'offline-emoji';
      off.textContent = '📴';
      off.title = `${p.name} is not connected`;
      off.setAttribute('aria-label', `${p.name} is not connected`);
      row.appendChild(off);
    }
    if (isCurrent) {
      row.style.color = '#ffd700';
      row.style.fontWeight = '900';
    }
    el.appendChild(row);
  });
  // Re-apply any active-speaker highlight after a re-render.
  if (typeof window !== 'undefined' && window._snlActiveSpeakers) {
    setActiveSpeakers(window._snlActiveSpeakers);
  }
}

/**
 * Adds a glowing mic emoji to the player rows whose slot keys are currently
 * speaking. Keyed by slot (player_0..3), not row order.
 * @param {string[]} slotKeys
 */
export function setActiveSpeakers(slotKeys = []) {
  const active = new Set(slotKeys);
  if (typeof window !== 'undefined') window._snlActiveSpeakers = slotKeys;
  document.querySelectorAll('#positions .player-row').forEach((row) => {
    const on = active.has(row.dataset.slot);
    row.classList.toggle('speaking', on);
  });
}

/* ======= ROLL BUTTON HELPERS ======= */

export function setRollButtonState(enabled, color) {
  const btn = document.getElementById('roll-btn');
  if (!btn) return;
  btn.disabled = !enabled;
  btn.classList.remove('color-red', 'color-brown', 'color-yellow', 'color-green', 'color-blue', 'color-purple');
  if (color) btn.classList.add(`color-${color}`);
}

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

import { BOARD_SIZE, TOTAL, SNAKES, LADDERS } from './engine.js';

const BOARD_SKINS = [
  '/images/board.png',
  '/images/board1.png',
  '/images/board2.png',
];

/* ======= AUDIO ======= */

const soundFiles = {
  roll: '/sounds/dice-roll.mp3',
  move: '/sounds/move.mp3',
  snake: '/sounds/snake.mp3',
  ladder: '/sounds/ladder.mp3',
  win: '/sounds/win.mp3',
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

export function isMuted() { return _muted; }

export function setMuted(value) {
  _muted = !!value;
  try { localStorage.setItem(MUTE_KEY, _muted ? '1' : '0'); } catch (_) {}
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

let currentBoardIndex = 0;

export function setBoardSkin(index) {
  currentBoardIndex = ((index % BOARD_SKINS.length) + BOARD_SKINS.length) % BOARD_SKINS.length;
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

function readCurrentPositions() {
  // Read positions back from DOM tokens — used after board skin change
  const tokens = document.querySelectorAll('.token');
  if (!tokens.length) return null;
  return Array.from(tokens).map((t) => parseInt(t.dataset.position, 10) || 1);
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
 * Creates N tokens (idx 0..N-1) inside #board-wrapper.
 * Idempotent — removes any existing tokens first.
 */
export function createTokens(playerCount) {
  const wrapper = document.getElementById('board-wrapper');
  if (!wrapper) return;
  // Remove any existing tokens
  wrapper.querySelectorAll('.token').forEach((t) => t.remove());
  for (let i = 0; i < playerCount; i++) {
    const t = document.createElement('div');
    t.id = `token${i}`;
    t.className = `token token${i + 1}`; // token1..token4 — color via CSS
    t.dataset.position = '0';
    t.setAttribute('aria-label', `Player ${i + 1} token`);
    wrapper.appendChild(t);
  }
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
 * @param {number[]} positions — array of position numbers per player
 */
export function placeTokens(positions) {
  const wrapper = document.getElementById('board-wrapper');
  if (!wrapper) return;

  // Read current cell size (token size CSS var) to derive proportional offsets
  const tokenSize = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--token-size')) || 22;
  // Half-step offset: ~38% of token size keeps them touching but distinct
  const d = tokenSize * 0.38;

  // Group ALL players (including pen players at position 0) by cell so that
  // tokens stacked at virtual square 0 also receive 2/3/4-token offsets.
  // We use cell key 0 for the virtual pen.
  const cellGroups = new Map(); // cell -> [playerIdx,...]
  positions.forEach((pos, i) => {
    const key = pos < 1 ? 0 : pos;
    if (!cellGroups.has(key)) cellGroups.set(key, []);
    cellGroups.get(key).push(i);
  });

  // Pre-compute virtual square 0 center: one cell-width to the left of square 1.
  let virtualZeroCenter = null;
  if (cellGroups.has(0)) {
    const c1 = getCellCenter(1);
    const gridEl = document.getElementById('grid');
    const cell1 = gridEl ? gridEl.querySelector('[data-cell="1"]') : null;
    const cellW = cell1 ? cell1.getBoundingClientRect().width : 0;
    virtualZeroCenter = { x: c1.x - cellW, y: c1.y };
  }

  positions.forEach((pos, i) => {
    const tok = document.getElementById(`token${i}`);
    if (!tok) return;

    const groupKey = pos < 1 ? 0 : pos;
    const center = groupKey === 0 ? virtualZeroCenter : getCellCenter(pos);
    if (!center) return;

    const group = cellGroups.get(groupKey) || [i];
    const idxInGroup = group.indexOf(i);
    const groupSize = group.length;

    let dx = 0, dy = 0;
    if (groupSize === 2) {
      dx = idxInGroup === 0 ? -d : d;
      dy = 0;
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
    tok.style.left = `${center.x + dx}px`;
    tok.style.top = `${center.y + dy}px`;
    tok.dataset.position = String(pos);
  });
}

export function highlightActiveToken(activeIdx) {
  document.querySelectorAll('.token').forEach((t, i) => {
    t.classList.toggle('token-active', i === activeIdx);
  });
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

/**
 * Animates a token stepping forward N squares one at a time.
 * Tokens at position 0 (virtual square 0, just left of square 1) hop onto
 * square 1 with the same animation as any other step. Updates DOM only —
 * caller is responsible for syncing engine state.
 * @returns {Promise<void>}
 */
export function animateSteps(playerIdx, steps, currentPositions) {
  return new Promise((resolve) => {
    if (steps <= 0) { resolve(); return; }
    const tok = document.getElementById(`token${playerIdx}`);
    if (!tok) { resolve(); return; }

    let count = 0;
    const tick = setInterval(() => {
      count++;
      currentPositions[playerIdx] = Math.min(TOTAL, currentPositions[playerIdx] + 1);
      tok.classList.remove('slide');
      void tok.offsetWidth;
      tok.classList.add('slide');
      playSound('move');
      placeTokens(currentPositions);
      if (count >= steps) {
        clearInterval(tick);
        resolve();
      }
    }, 300);
  });
}

/**
 * Animates a snake or ladder slide from current to target square.
 * @param {'snake'|'ladder'} type
 * @returns {Promise<void>}
 */
export function animateSnakeOrLadder(playerIdx, targetCell, type, currentPositions) {
  return new Promise((resolve) => {
    const tok = document.getElementById(`token${playerIdx}`);
    if (!tok) { resolve(); return; }
    const startCell = currentPositions[playerIdx];
    const start = getCellCenter(startCell);
    const end = getCellCenter(targetCell);
    if (type === 'ladder') playSound('ladder');
    else playSound('snake');

    const hitClass = type === 'snake' ? 'snake-hit' : 'ladder-hit';
    tok.classList.add(hitClass);
    const hitDuration = 500;

    setTimeout(() => {
      tok.classList.remove(hitClass);
      const frames = 20;
      let frame = 0;
      const jump = setInterval(() => {
        frame++;
        const t = frame / frames;
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        const x = start.x + (end.x - start.x) * ease;
        const y = start.y + (end.y - start.y) * ease;
        const lift = Math.sin(Math.PI * t) * 18;
        tok.style.left = `${x}px`;
        tok.style.top = `${y - lift}px`;
        if (frame >= frames) {
          clearInterval(jump);
          currentPositions[playerIdx] = targetCell;
          placeTokens(currentPositions);
          resolve();
        }
      }, 22);
    }, hitDuration);
  });
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

export function renderPositions(state, localIdx) {
  const el = document.getElementById('positions');
  if (!el) return;
  el.innerHTML = '';
  el.className = `positions players-${state.players.length}`;
  state.players.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'player-row';
    const isMe = i === localIdx;
    const isCurrent = i === state.currentPlayerIndex;
    // Color dot prefix matches token color
    const colorDots = ['🔴', '🟢', '🔵', '🟡'];
    const dot = colorDots[i] || '⚪';
    const meTag = isMe ? ' (you)' : '';
    row.textContent = `${dot} ${p.emoji} ${p.name}${meTag}: ${p.position}`;
    if (isCurrent) {
      row.style.color = '#ffd700';
      row.style.fontWeight = '900';
    }
    el.appendChild(row);
  });
}

/* ======= ROLL BUTTON HELPERS ======= */

export function setRollButtonState(enabled, playerIndex) {
  const btn = document.getElementById('roll-btn');
  if (!btn) return;
  btn.disabled = !enabled;
  btn.classList.remove('p1-turn', 'p2-turn', 'p3-turn', 'p4-turn');
  if (playerIndex != null) {
    btn.classList.add(`p${playerIndex + 1}-turn`);
  }
}

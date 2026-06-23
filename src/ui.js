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

function pauseBackgroundMusic() {
  if (backgroundMusic) {
    try {
      backgroundMusic.pause();
    } catch (_) {}
  }
}

function resumeBackgroundMusic() {
  if (backgroundMusic && backgroundMusic.paused && !_muted) {
    try {
      backgroundMusic.play().catch(() => {});
    } catch (_) {}
  }
}

export function startBackgroundMusic() {
  if (_muted) return;
  if (backgroundMusic) return; // Already playing
  
  try {
    backgroundMusic = new Audio(soundFiles.music);
    backgroundMusic.loop = true;
    backgroundMusic.volume = 0.10; // 10% volume
    backgroundMusic.play().catch(() => {
      backgroundMusic = null;
    });
  } catch (_) {
    backgroundMusic = null;
  }
}

export function stopBackgroundMusic() {
  if (backgroundMusic) {
    try {
      backgroundMusic.pause();
      backgroundMusic.currentTime = 0;
      backgroundMusic = null;
    } catch (_) {}
  }
}

export function setBackgroundMusicVolume(volume) {
  if (backgroundMusic) {
    try {
      backgroundMusic.volume = Math.max(0, Math.min(1, volume));
    } catch (_) {}
  }
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
  // Read positions back from DOM tokens — used after board skin change.
  // Note: 0 is a valid position (virtual square 0, off-board pen), so we
  // can't use `|| 1` here — that would silently drag pen tokens to sq 1.
  const tokens = document.querySelectorAll('.token');
  if (!tokens.length) return null;
  return Array.from(tokens).map((t) => {
    const v = parseInt(t.dataset.position, 10);
    return Number.isFinite(v) ? v : 0;
  });
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
 * @param {string[]} colors — array of color ids per player ('red'|'orange'|...)
 */
export function createTokens(colors) {
  const wrapper = document.getElementById('board-wrapper');
  if (!wrapper) return;
  // Remove any existing tokens
  wrapper.querySelectorAll('.token').forEach((t) => t.remove());
  const playerCount = colors.length;
  for (let i = 0; i < playerCount; i++) {
    const t = document.createElement('div');
    t.id = `token${i}`;
    t.className = 'token';
    t.dataset.color = colors[i] || 'red';
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
        // Only the final hop onto square 100 needs an extra pause: its CSS
        // transition (260ms) gets cut off when handleWin swaps to the
        // results screen immediately. Non-winning moves resolve right away
        // so the next turn starts without a noticeable delay.
        if (currentPositions[playerIdx] === TOTAL) {
          setTimeout(resolve, 320);
        } else {
          resolve();
        }
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

/**
 * Animates a token being captured and sent back to position 0 (start).
 * Shows penalty glow effect while the token flies back.
 * @param {number} capturedPlayerIdx - Index of the captured player
 * @param {Array<number>} currentPositions - Current positions array for animation tracking
 * @returns {Promise<void>}
 */
export function animateCaptureToken(capturedPlayerIdx, currentPositions) {
  return new Promise((resolve) => {
    const tok = document.getElementById(`token${capturedPlayerIdx}`);
    if (!tok) { resolve(); return; }

    const startPos = currentPositions[capturedPlayerIdx];
    if (startPos === 0) { resolve(); return; } // Already at start

    // Apply penalty glow effect
    tok.classList.add('penalty');

    // Get start and end positions for animation
    const start = getCellCenter(startPos);
    // Virtual square 0 is one cell-width to the left of square 1
    const c1 = getCellCenter(1);
    const gridEl = document.getElementById('grid');
    const cell1 = gridEl ? gridEl.querySelector('[data-cell="1"]') : null;
    const cellW = cell1 ? cell1.getBoundingClientRect().width : 0;
    const end = { x: c1.x - cellW, y: c1.y };

    // Animate the token flying back to position 0
    const frames = 30; // Longer animation for visibility
    let frame = 0;
    const flyBack = setInterval(() => {
      frame++;
      const t = frame / frames;
      // Ease-in-out for smooth motion
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      const x = start.x + (end.x - start.x) * ease;
      const y = start.y + (end.y - start.y) * ease;
      // Add a slight arc to the movement
      const arc = Math.sin(Math.PI * t) * 20;
      tok.style.left = `${x}px`;
      tok.style.top = `${y - arc}px`;

      if (frame >= frames) {
        clearInterval(flyBack);
        // Remove penalty effect after animation completes
        setTimeout(() => {
          tok.classList.remove('penalty');
        }, 300);
        currentPositions[capturedPlayerIdx] = 0;
        placeTokens(currentPositions);
        resolve();
      }
    }, 25); // 30 frames * 25ms = 750ms total animation
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
  // Map color ids to dot emojis (visual cue in the player list)
  const colorDots = {
    red: '🔴', brown: '🟤', yellow: '🟡',
    green: '🟢', blue: '🔵', purple: '🟣',
  };
  state.players.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'player-row';
    const isMe = i === localIdx;
    const isCurrent = i === state.currentPlayerIndex;
    const dot = colorDots[p.color] || '⚪';
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

export function setRollButtonState(enabled, color) {
  const btn = document.getElementById('roll-btn');
  if (!btn) return;
  btn.disabled = !enabled;
  btn.classList.remove('color-red', 'color-brown', 'color-yellow', 'color-green', 'color-blue', 'color-purple');
  if (color) btn.classList.add(`color-${color}`);
}

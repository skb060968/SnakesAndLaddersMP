/**
 * Snakes & Ladders MP — UI Module
 *
 * DOM rendering + animations for the gameplay screen.
 * Pure rendering (no game logic, no Firebase).
 *
 * The board itself (squares, snakes, ladders, tokens and their animations) is
 * rendered in 3D by board3d.js, which exposes the same board API this module
 * used to. This module keeps everything around the board.
 *
 * Exposes:
 *   - throwDiceVisual(value)     — animates the CSS dice cube
 *   - resetDice()
 *   - playSound(name)            — fires audio; music + mute controls
 *   - setMessage(text)           — sets the message line
 *   - setTurn(text)              — sets the turn header
 *   - renderPositions(state, localIdx) — fills the positions list
 *   - setActiveSpeakers(slotKeys), setRollButtonState(enabled, color)
 */

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

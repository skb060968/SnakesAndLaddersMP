/**
 * Firebase Sync — multi-room operations for Snakes & Ladders MP.
 *
 * Rooms stored under `snl-rooms/{roomCode}` to keep the namespace
 * separate from other games sharing the same Firebase project.
 *
 * Mirrors the proven pattern used by Card Games and Tambola.
 */

import { db, auth } from './firebase-config.js';
import { ref } from 'firebase/database';
import { set } from 'firebase/database';
import { get } from 'firebase/database';
import { update } from 'firebase/database';
import { remove } from 'firebase/database';
import { onValue } from 'firebase/database';
import { off } from 'firebase/database';
import { onDisconnect } from 'firebase/database';

/** Room code charset — letters only, excludes ambiguous I and O. */
const ROOM_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const ROOM_PATH = 'snl-rooms';

/* ======= RETRY HELPER ======= */

export async function firebaseRetry(fn, maxRetries = 2, delayMs = 500) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      console.warn(`Firebase retry ${attempt + 1}/${maxRetries}:`, err.message);
      await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
}

/* ======= ROOM CODE ======= */

export function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += ROOM_CODE_CHARSET[Math.floor(Math.random() * ROOM_CODE_CHARSET.length)];
  }
  return code;
}

/* ======= CREATE / JOIN ======= */

/**
 * Creates a new room and adds the host as player_0.
 * @param {string} hostName
 * @param {string} hostEmoji
 * @param {string} hostColor — token color id ('red'|'orange'|'yellow'|'green'|'blue'|'purple')
 * @returns {Promise<{ roomCode: string, playerIndex: number }>}
 */
export async function createRoom(hostName, hostEmoji, hostColor) {
  const uid = auth.currentUser?.uid || 'anonymous';
  const roomCode = generateRoomCode();
  const roomRef = ref(db, `${ROOM_PATH}/${roomCode}`);

  const roomData = {
    meta: {
      hostUid: uid,
      hostName,
      status: 'lobby',
      createdAt: Date.now(),
      lastActivity: Date.now(),
    },
    players: {
      player_0: {
        name: hostName,
        emoji: hostEmoji,
        color: hostColor || 'red',
        uid,
        connected: true,
      },
    },
    game: null,
    ready: {},
  };

  await firebaseRetry(() => set(roomRef, roomData));
  return { roomCode, playerIndex: 0 };
}

/**
 * Joins an existing room. Rejects if not in lobby state, full (4 players), or
 * if the requested color is already taken by another player.
 * @returns {Promise<{ success: boolean, playerIndex?: number, reason?: string }>}
 */
export async function joinRoom(roomCode, playerName, playerEmoji, playerColor) {
  const roomRef = ref(db, `${ROOM_PATH}/${roomCode}`);
  
  let snapshot;
  try {
    snapshot = await get(roomRef);
  } catch (err) {
    console.error('Firebase get error:', err);
    return { success: false, reason: 'Failed to fetch room' };
  }
  
  if (!snapshot.exists()) return { success: false, reason: 'Room not found' };

  const data = snapshot.val();
  if (data.meta?.status !== 'lobby') {
    return { success: false, reason: 'Game already in progress' };
  }

  const players = data.players || {};
  // A "ghost" slot is one with no name (only a leftover `connected:false`
  // written by a stale onDisconnect after the player left). Filter from
  // the index calculation and clean up so the lobby doesn't show empty cards.
  const ghostKeys = Object.keys(players).filter((k) => !players[k] || !players[k].name);
  const validKeys = Object.keys(players).filter((k) => players[k] && players[k].name);
  const existingIndices = validKeys
    .map((k) => parseInt(k.replace('player_', ''), 10))
    .filter((n) => !isNaN(n));
  if (existingIndices.length >= 4) return { success: false, reason: 'Room is full' };

  // Color collision check — must be a free color (only against valid players).
  const takenColors = new Set(
    validKeys.map((k) => players[k].color).filter(Boolean)
  );
  if (playerColor && takenColors.has(playerColor)) {
    return { success: false, reason: 'That color is already taken' };
  }

  if (ghostKeys.length > 0) {
    try {
      const cleanup = {};
      ghostKeys.forEach((k) => { cleanup[`players/${k}`] = null; });
      await update(ref(db, `${ROOM_PATH}/${roomCode}`), cleanup);
    } catch (_) {}
  }

  const nextIndex = existingIndices.length > 0 ? Math.max(...existingIndices) + 1 : 0;
  const uid = auth.currentUser?.uid || 'anonymous';

  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}`), {
      [`players/player_${nextIndex}`]: {
        name: playerName,
        emoji: playerEmoji,
        color: playerColor || 'red',
        uid,
        connected: true,
      },
      'meta/lastActivity': Date.now(),
    })
  );

  return { success: true, playerIndex: nextIndex };
}

/* ======= LISTEN ======= */

/**
 * Subscribes to a room's live state.
 * @param {string} roomCode
 * @param {object} callbacks { onPlayersChange, onGameUpdate, onStatusChange, onRoomDeleted }
 * @returns {Function} unsubscribe
 */
export function listenRoom(roomCode, callbacks) {
  const roomRef = ref(db, `${ROOM_PATH}/${roomCode}`);

  const handler = (snapshot) => {
    if (!snapshot.exists()) {
      if (callbacks.onRoomDeleted) callbacks.onRoomDeleted();
      return;
    }
    const data = snapshot.val();
    if (callbacks.onPlayersChange && data.players) callbacks.onPlayersChange(data.players);
    if (callbacks.onGameUpdate && data.game) callbacks.onGameUpdate(data.game, data.lastMove || null);
    if (callbacks.onStatusChange && data.meta) callbacks.onStatusChange(data.meta.status);
  };

  onValue(roomRef, handler);
  return () => off(roomRef, 'value', handler);
}

/* ======= STATE WRITES ======= */

/**
 * Writes full game state (used on game start and after each turn).
 */
export async function writeGameState(roomCode, gameStateSerialized, lastMove) {
  const updates = {
    game: gameStateSerialized,
    lastMove: lastMove || null,
    'meta/lastActivity': Date.now(),
  };
  if (gameStateSerialized.status === 'playing') {
    updates['meta/status'] = 'active';
  }
  await firebaseRetry(() => update(ref(db, `${ROOM_PATH}/${roomCode}`), updates));
}


/* ======= ROOM LIFECYCLE ======= */

/** Sets up onDisconnect to mark a player as disconnected on connection drop. */
export function setupDisconnectHandler(roomCode, playerIndex) {
  const connectedRef = ref(db, `${ROOM_PATH}/${roomCode}/players/player_${playerIndex}/connected`);
  onDisconnect(connectedRef).set(false).catch((err) => {
    console.warn('onDisconnect setup failed:', err.message);
  });
}

/**
 * Player leaves the lobby. Cancels the queued onDisconnect first so it
 * doesn't fire and recreate a ghost slot after the page closes, then
 * removes the player node.
 */
export async function leavePlayer(roomCode, playerIndex) {
  const connectedRef = ref(db, `${ROOM_PATH}/${roomCode}/players/player_${playerIndex}/connected`);
  try { await onDisconnect(connectedRef).cancel(); } catch (_) {}
  await firebaseRetry(() =>
    remove(ref(db, `${ROOM_PATH}/${roomCode}/players/player_${playerIndex}`))
  );
}

/**
 * Host removes a player from the lobby (kick).
 * Similar to leavePlayer but can be called by the host on any player.
 */
export async function removePlayer(roomCode, playerIndex) {
  await firebaseRetry(() =>
    remove(ref(db, `${ROOM_PATH}/${roomCode}/players/player_${playerIndex}`))
  );
}

export async function endRoom(roomCode) {
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}/meta`), {
      status: 'ended',
      lastActivity: Date.now(),
    })
  );
}

export async function deleteRoom(roomCode) {
  await firebaseRetry(() => remove(ref(db, `${ROOM_PATH}/${roomCode}`)));
}

/** Resets room to lobby state for a new round. Keeps players, clears game/ready. */
export async function resetRoom(roomCode) {
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}`), {
      'meta/status': 'lobby',
      'meta/lastActivity': Date.now(),
      game: null,
      lastMove: null,
      ready: {},
    })
  );
}

/* ======= READY STATE (PLAY AGAIN) ======= */

/**
 * Sets a player's ready state on the results screen.
 * Used for the "Play Again" flow:
 * - true = player clicked Play Again (green dot)
 * - 'left' = player clicked Home (red dot)
 * - undefined/null = waiting (hollow dot)
 * 
 * @param {string} roomCode
 * @param {number} playerIndex
 * @param {boolean|'left'} status
 */
export async function setPlayerReady(roomCode, playerIndex, status) {
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}/ready`), {
      [`player_${playerIndex}`]: status,
    })
  );
}

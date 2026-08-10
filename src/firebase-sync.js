/** Secure Firebase synchronization for Snakes & Ladders MP schema v2. */
import { db, auth, authReady } from './firebase-config.js';
import {
  get, off, onDisconnect, onValue, ref, remove, runTransaction, set, update,
} from 'firebase/database';

const ROOM_PATH = 'snl-rooms';
const ROOM_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const ROOM_CODE_RE = /^[A-HJ-NP-Z]{4}$/;
const PLAYER_KEY_RE = /^player_([0-3])$/;
const COLORS = new Set(['red', 'brown', 'yellow', 'green', 'blue', 'purple']);
const TRANSIENT_CODES = new Set([
  'database/disconnected', 'database/network-error', 'database/unavailable',
  'unavailable', 'network-request-failed',
]);

const roomPath = (code) => `${ROOM_PATH}/${normalizeRoomCode(code)}`;
const playerKeyFor = (index) => `player_${index}`;
const playerIndexFrom = (key) => Number.parseInt(key.replace('player_', ''), 10);
const now = () => Date.now();
let stopPresence = null;

function normalizeRoomCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!ROOM_CODE_RE.test(code)) throw new Error('Invalid room code');
  return code;
}

function cleanText(value, fallback, maxLength) {
  const text = String(value || '').trim();
  return (text || fallback).slice(0, maxLength);
}

async function requireUser() {
  const user = await authReady;
  if (!user?.uid || auth.currentUser?.uid !== user.uid) throw new Error('Authentication unavailable');
  return user;
}

export async function firebaseRetry(fn, maxRetries = 2, delayMs = 500) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await fn(); } catch (error) {
      const code = String(error?.code || '').toLowerCase();
      if (attempt >= maxRetries || !TRANSIENT_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
}

export function generateRoomCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => ROOM_CODE_CHARSET[byte % ROOM_CODE_CHARSET.length]).join('');
}

export async function createRoom(hostName, hostEmoji, hostColor) {
  const user = await requireUser();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const roomCode = generateRoomCode();
    const createdAt = now();
    const room = {
      schemaVersion: 2,
      meta: {
        hostUid: user.uid,
        hostName: cleanText(hostName, 'Host', 12),
        status: 'lobby',
        createdAt,
        lastActivity: createdAt,
      },
      players: {
        player_0: {
          name: cleanText(hostName, 'Host', 12),
          emoji: cleanText(hostEmoji, '😀', 8),
          color: COLORS.has(hostColor) ? hostColor : 'red',
          uid: user.uid,
          connected: true,
          joinedAt: createdAt,
        },
      },
    };
    const result = await firebaseRetry(() => runTransaction(
      ref(db, roomPath(roomCode)),
      (current) => current === null ? room : undefined,
      { applyLocally: false },
    ));
    if (result.committed) return { roomCode, playerIndex: 0 };
  }
  throw new Error('Unable to reserve a room code. Try again.');
}

export async function joinRoom(roomCode, playerName, playerEmoji, playerColor) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const roomRef = ref(db, roomPath(code));
  let snapshot = await firebaseRetry(() => get(roomRef));
  if (!snapshot.exists()) return { success: false, reason: 'Room not found' };
  let room = snapshot.val();
  if (room.schemaVersion !== 2) return { success: false, reason: 'Room version is outdated' };

  const ownedKey = Object.keys(room.players || {}).find((key) => room.players[key]?.uid === user.uid);
  if (ownedKey) {
    await set(ref(db, `${roomPath(code)}/players/${ownedKey}/connected`), true);
    return { success: true, playerIndex: playerIndexFrom(ownedKey) };
  }
  if (room.meta?.status !== 'lobby') return { success: false, reason: 'Game already in progress' };
  const color = COLORS.has(playerColor) ? playerColor : 'red';
  if (Object.values(room.players || {}).some((player) => player?.color === color)) {
    return { success: false, reason: 'That color is already taken' };
  }

  for (let index = 1; index <= 3; index += 1) {
    const key = playerKeyFor(index);
    const joinedAt = now();
    try {
      const result = await runTransaction(ref(db, `${roomPath(code)}/players/${key}`), (current) => {
        if (current !== null) return undefined;
        return {
          name: cleanText(playerName, 'Player', 12),
          emoji: cleanText(playerEmoji, '😀', 8),
          color,
          uid: user.uid,
          connected: true,
          joinedAt,
        };
      }, { applyLocally: false });
      if (result.committed) return { success: true, playerIndex: index };
    } catch (error) {
      if (String(error?.code || '').includes('permission-denied')) {
        snapshot = await get(roomRef);
        room = snapshot.val() || {};
        const owned = Object.keys(room.players || {}).find((candidate) => room.players[candidate]?.uid === user.uid);
        if (owned) return { success: true, playerIndex: playerIndexFrom(owned) };
        if (Object.values(room.players || {}).some((player) => player?.color === color)) {
          return { success: false, reason: 'That color is already taken' };
        }
        if (room.meta?.status !== 'lobby') return { success: false, reason: 'Game already in progress' };
        continue;
      }
      throw error;
    }
  }
  return { success: false, reason: 'Room is full (4 players)' };
}

export function listenRoom(roomCode, callbacks) {
  const roomRef = ref(db, roomPath(roomCode));
  const handler = (snapshot) => {
    if (!snapshot.exists()) { callbacks.onRoomDeleted?.(); return; }
    const room = snapshot.val();
    if (room.schemaVersion !== 2) {
      callbacks.onError?.(new Error('Unsupported room version'));
      return;
    }
    callbacks.onRoomSnapshot?.(room);
    callbacks.onPlayersChange?.(room.players || {});
    if (room.game) callbacks.onGameUpdate?.(room.game, room.game.lastMove || null);
    const status = room.meta?.status === 'ended' || room.game?.status === 'finished'
      ? 'ended'
      : room.game?.status === 'playing' ? 'active' : room.meta?.status;
    callbacks.onStatusChange?.(status, room);
  };
  onValue(roomRef, handler, (error) => callbacks.onError?.(error));
  return () => off(roomRef, 'value', handler);
}

export async function setupDisconnectHandler(roomCode, playerIndex) {
  await stopPresenceTracking();
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const key = playerKeyFor(playerIndex);
  if (!PLAYER_KEY_RE.test(key)) throw new Error('Invalid player slot');
  const playerRef = ref(db, `${roomPath(code)}/players/${key}`);
  const playerSnapshot = await get(playerRef);
  if (!playerSnapshot.exists() || playerSnapshot.val()?.uid !== user.uid) {
    throw new Error('Player session is no longer valid');
  }

  const connectedRef = ref(db, `${roomPath(code)}/players/${key}/connected`);
  const infoRef = ref(db, '.info/connected');
  let registration = null;
  let disposed = false;
  const handler = async (snapshot) => {
    if (!snapshot.val() || disposed) return;
    try {
      registration = onDisconnect(connectedRef);
      await registration.set(false);
      if (!disposed) await set(connectedRef, true);
    } catch (error) {
      console.warn('Presence update failed:', error.message);
    }
  };
  onValue(infoRef, handler);
  stopPresence = async () => {
    disposed = true;
    off(infoRef, 'value', handler);
    try { await registration?.cancel(); } catch (_) {}
  };
  return stopPresence;
}

export async function stopPresenceTracking() {
  const cleanup = stopPresence;
  stopPresence = null;
  if (cleanup) await cleanup();
}

function operation(type, user, playerKey, roundId, revision) {
  return { type, ownerUid: user.uid, playerKey, roundId, revision, timestamp: now() };
}

function normalizeMove(move, roundId, revision) {
  const normalized = {
    roller: move.roller,
    rollerKey: move.rollerKey,
    roll: move.roll,
    kind: move.kind,
    steps: move.steps || 0,
    win: Boolean(move.win),
    roundId,
    revision,
    timestamp: move.timestamp || now(),
  };
  if (move.landing != null) normalized.landing = move.landing;
  if (move.snakeLadderTo != null) normalized.snakeLadderTo = move.snakeLadderTo;
  if (move.capturedPlayer != null) normalized.capturedPlayer = move.capturedPlayer;
  if (move.capturedPlayerKey) normalized.capturedPlayerKey = move.capturedPlayerKey;
  return normalized;
}

export async function startGameState(roomCode, serializedState) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const roundId = now();
  const game = {
    ...serializedState,
    status: 'playing',
    roundId,
    revision: 0,
    operation: operation('start', user, 'player_0', roundId, 0),
  };
  delete game.lastMove;
  const result = await runTransaction(ref(db, `${roomPath(code)}/game`), (current) => (
    current === null ? game : undefined
  ), { applyLocally: false });
  if (!result.committed) throw new Error('Game was already started');
  await update(ref(db, `${roomPath(code)}/meta`), { status: 'active', lastActivity: now() });
  return result.snapshot.val();
}

export async function commitMove(roomCode, expectedRevision, serializedState, lastMove) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  let committedGame = null;
  const result = await runTransaction(ref(db, `${roomPath(code)}/game`), (current) => {
    if (!current || current.status !== 'playing' || current.revision !== expectedRevision) return undefined;
    if (current.currentPlayerKey !== lastMove.rollerKey) return undefined;
    const revision = current.revision + 1;
    committedGame = {
      ...serializedState,
      roundId: current.roundId,
      revision,
      operation: operation('move', user, current.currentPlayerKey, current.roundId, revision),
      lastMove: normalizeMove(lastMove, current.roundId, revision),
    };
    return committedGame;
  }, { applyLocally: false });
  if (!result.committed) throw new Error('Turn changed before this roll was committed');
  return result.snapshot.val();
}

async function ownedPlayerKey(code, user) {
  const snapshot = await get(ref(db, `${roomPath(code)}/players`));
  const players = snapshot.val() || {};
  return Object.keys(players).find((key) => players[key]?.uid === user.uid) || null;
}

export async function setSharedBoardIndex(roomCode, boardIndex) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const key = await ownedPlayerKey(code, user);
  if (!key) throw new Error('Player session is no longer valid');
  const result = await runTransaction(ref(db, `${roomPath(code)}/game`), (current) => {
    if (!current || current.status !== 'playing') return undefined;
    const revision = current.revision + 1;
    return {
      ...current,
      boardIndex,
      revision,
      operation: operation('board', user, key, current.roundId, revision),
    };
  }, { applyLocally: false });
  if (!result.committed) throw new Error('Unable to change board now');
  return result.snapshot.val();
}

export async function endRoom(roomCode) {
  await requireUser();
  const code = normalizeRoomCode(roomCode);
  const gameSnapshot = await get(ref(db, `${roomPath(code)}/game`));
  if (!gameSnapshot.exists()) throw new Error('No active round');
  await update(ref(db, `${roomPath(code)}/meta`), { status: 'ended', lastActivity: now() });
  const ended = { ...gameSnapshot.val(), status: 'finished' };
  delete ended.winnerKey;
  return ended;
}

export async function resetRoom(roomCode) {
  await requireUser();
  const code = normalizeRoomCode(roomCode);
  await update(ref(db, roomPath(code)), {
    game: null,
    ready: null,
    'meta/status': 'lobby',
    'meta/lastActivity': now(),
  });
}

export async function leavePlayer(roomCode, playerIndex) {
  await requireUser();
  const code = normalizeRoomCode(roomCode);
  const key = playerKeyFor(playerIndex);
  const connectedRef = ref(db, `${roomPath(code)}/players/${key}/connected`);
  await stopPresenceTracking();
  try { await onDisconnect(connectedRef).cancel(); } catch (_) {}
  await remove(ref(db, `${roomPath(code)}/players/${key}`));
}

export async function removePlayer(roomCode, playerIndex) {
  await requireUser();
  const code = normalizeRoomCode(roomCode);
  const key = playerKeyFor(playerIndex);
  if (key === 'player_0' || !PLAYER_KEY_RE.test(key)) throw new Error('Invalid player slot');
  await remove(ref(db, `${roomPath(code)}/players/${key}`));
}

export async function deleteRoom(roomCode) {
  await requireUser();
  await stopPresenceTracking();
  await remove(ref(db, roomPath(roomCode)));
}

export async function setPlayerReady(roomCode, playerIndex, status) {
  await requireUser();
  if (status !== true && status !== 'left') throw new Error('Invalid ready status');
  const key = playerKeyFor(playerIndex);
  if (!PLAYER_KEY_RE.test(key)) throw new Error('Invalid player slot');
  await set(ref(db, `${roomPath(roomCode)}/ready/${key}`), status);
}
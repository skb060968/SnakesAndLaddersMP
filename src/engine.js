/**
 * Snakes & Ladders — Pure Game Engine
 *
 * Pure, deterministic game logic. No DOM, no Firebase, no animations.
 * All public functions take a state object and return a new state object
 * (immutable update style) so the calling code can sync, animate, validate.
 *
 * Game rules (preserved from the original SnakesAndLadders project):
 *  - 10x10 board, 100 squares
 *  - Players start off-board (position 0, virtual square 0) and race to square 100
 *  - Roll a 6 → bonus turn (roll again, no movement yet — six is "stored")
 *  - Sixes accumulate; on the next non-six roll, total moves at once
 *  - Three sixes in a row → penalty: turn is forfeited, no movement
 *  - Exact-roll-to-win: must reach 100 exactly. If accumulated would overshoot,
 *    turn is forfeited.
 *  - Snakes and ladders fire on the final landing square (after a move resolves)
 */

/* ======= BOARD CONSTANTS ======= */

export const BOARD_SIZE = 10;
export const TOTAL = BOARD_SIZE * BOARD_SIZE;
export const WIN_RULE = 'exact';

export const SNAKES = Object.freeze({
  99: 84,
  95: 74,
  89: 73,
  66: 57,
  63: 59,
  38: 25,
  32: 30,
  20: 18,
});

export const LADDERS = Object.freeze({
  5: 26,
  21: 59,
  28: 47,
  49: 68,
  64: 85,
});

/* ======= GAME CREATION ======= */

/**
 * Creates initial game state for an N-player game (2-4 players).
 * @param {Array<{name: string, emoji: string}>} playerInfos
 * @returns {object} GameState
 */
export function createGame(playerInfos) {
  const n = playerInfos.length;
  if (n < 2 || n > 4) throw new Error(`Invalid player count: ${n}. Must be 2-4 players.`);
  const slotKeys = new Set();
  const players = playerInfos.map((info) => {
    const slotKey = String(info.slotKey || '');
    if (!/^player_[0-3]$/.test(slotKey) || slotKeys.has(slotKey)) {
      throw new Error('Invalid or duplicate player slot');
    }
    slotKeys.add(slotKey);
    return {
      slotKey,
      name: info.name,
      emoji: info.emoji,
      color: info.color || 'red',
      position: 0,
      accumulatedSteps: 0,
      consecutiveSixes: 0,
      won: false,
      connected: true,
    };
  });
  return {
    players,
    currentPlayerIndex: 0,
    status: 'playing',
    winnerIndex: null,
    boardIndex: 0,
    roundId: null,
    revision: 0,
  };
}

/* ======= TURN ROTATION ======= */

/**
 * Returns the next player index (skips no one — all players take turns).
 */
export function nextPlayerIndex(state) {
  return (state.currentPlayerIndex + 1) % state.players.length;
}

/* ======= ROLL APPLICATION ======= */

/**
 * Applies a dice roll outcome to the current player.
 * Returns a structured outcome describing what happens, plus the new state.
 *
 * Outcome.kind values:
 *   'overshoot' — exact-rule violation; turn forfeited, accumulated reset
 *   'three-sixes' — third consecutive six; penalty, turn forfeited
 *   'six-bonus' — non-winning six; player rolls again
 *   'win-with-sixes' — accumulated + this six lands exactly on 100
 *   'normal-move' — moved by (accumulatedSteps + roll), check snake/ladder
 *   'ladder-bonus' — climbed a ladder; player rolls again
 *
 * For 'normal-move', 'win-with-sixes', and 'ladder-bonus', `outcome.steps` is the number of
 * forward steps to animate. `outcome.landing` is the square reached BEFORE
 * snake/ladder resolution. `outcome.snakeLadderTo` (optional) is the post-
 * snake-or-ladder square. `outcome.capturedPlayer` (optional) is the index of
 * a player whose token was sent back to start. `outcome.win` is true if the player won.
 *
 * The returned `state` reflects the new turn after this roll resolves
 * (turn advanced if move/forfeit, same player if six-bonus or ladder-bonus).
 *
 * @param {object} state
 * @param {number} roll  — 1..6
 * @returns {{ outcome: object, state: object }}
 */
export function applyRoll(state, roll) {
  if (state.status !== 'playing') {
    throw new Error('Cannot apply roll: game is not in playing status');
  }
  if (roll < 1 || roll > 6) {
    throw new Error(`Invalid roll: ${roll}`);
  }

  const idx = state.currentPlayerIndex;
  const player = state.players[idx];
  const startPos = player.position;
  const accumulated = player.accumulatedSteps;
  const intended = startPos + accumulated + roll;

  // ====== SIX HANDLING ======
  if (roll === 6) {
    // Overshoot via accumulated sixes — turn forfeit
    if (WIN_RULE === 'exact' && intended > TOTAL) {
      const newPlayers = state.players.map((p, i) =>
        i === idx ? { ...p, accumulatedSteps: 0, consecutiveSixes: 0 } : p
      );
      return {
        outcome: { kind: 'overshoot', roll, by: idx },
        state: { ...state, players: newPlayers, currentPlayerIndex: nextPlayerIndex(state) },
      };
    }

    const newAccumulated = accumulated + 6;

    // Win exactly on the bonus roll
    if (startPos + newAccumulated === TOTAL) {
      const newPlayers = state.players.map((p, i) =>
        i === idx
          ? { ...p, position: TOTAL, accumulatedSteps: 0, consecutiveSixes: 0, won: true }
          : p
      );
      return {
        outcome: {
          kind: 'win-with-sixes',
          roll,
          by: idx,
          steps: newAccumulated,
          landing: TOTAL,
          win: true,
        },
        state: {
          ...state,
          players: newPlayers,
          status: 'finished',
          winnerIndex: idx,
        },
      };
    }

    // Three consecutive sixes — penalty
    const newConsecutive = player.consecutiveSixes + 1;
    if (newConsecutive >= 3) {
      const newPlayers = state.players.map((p, i) =>
        i === idx ? { ...p, accumulatedSteps: 0, consecutiveSixes: 0 } : p
      );
      return {
        outcome: { kind: 'three-sixes', roll, by: idx },
        state: { ...state, players: newPlayers, currentPlayerIndex: nextPlayerIndex(state) },
      };
    }

    // Bonus turn — store the six, same player rolls again
    const newPlayers = state.players.map((p, i) =>
      i === idx ? { ...p, accumulatedSteps: newAccumulated, consecutiveSixes: newConsecutive } : p
    );
    return {
      outcome: { kind: 'six-bonus', roll, by: idx },
      state: { ...state, players: newPlayers /* currentPlayerIndex unchanged */ },
    };
  }

  // ====== NON-SIX ROLL ======
  const totalSteps = accumulated + roll;
  const finalIntended = startPos + totalSteps;

  // Overshoot
  if (WIN_RULE === 'exact' && finalIntended > TOTAL) {
    const newPlayers = state.players.map((p, i) =>
      i === idx ? { ...p, accumulatedSteps: 0, consecutiveSixes: 0 } : p
    );
    return {
      outcome: { kind: 'overshoot', roll, by: idx },
      state: { ...state, players: newPlayers, currentPlayerIndex: nextPlayerIndex(state) },
    };
  }

  // Move forward — resolve any snake/ladder at landing
  const landing = finalIntended;
  let finalPos = landing;
  let snakeLadderTo = null;
  let climbedLadder = false;
  
  if (LADDERS[landing] != null) {
    finalPos = LADDERS[landing];
    snakeLadderTo = finalPos;
    climbedLadder = true;
  } else if (SNAKES[landing] != null) {
    finalPos = SNAKES[landing];
    snakeLadderTo = finalPos;
  }

  // Check for capture: if another player is at finalPos, send them back to start (position 0)
  let capturedPlayer = null;
  const updatedPlayers = state.players.map((p, i) => {
    if (i !== idx && p.position === finalPos && finalPos !== TOTAL && finalPos > 0) {
      capturedPlayer = i;
      return { ...p, position: 0 }; // Send captured player back to start
    }
    return p;
  });

  const won = finalPos === TOTAL;

  const newPlayers = updatedPlayers.map((p, i) =>
    i === idx
      ? {
          ...p,
          position: finalPos,
          accumulatedSteps: 0,
          consecutiveSixes: 0,
          won,
        }
      : p
  );

  // If climbed a ladder (and didn't win), give bonus turn
  if (climbedLadder && !won) {
    return {
      outcome: {
        kind: 'ladder-bonus',
        roll,
        by: idx,
        steps: totalSteps,
        landing,
        snakeLadderTo,
        capturedPlayer,
        win: false,
      },
      state: {
        ...state,
        players: newPlayers,
        status: 'playing',
        // currentPlayerIndex stays the same for bonus turn
      },
    };
  }

  return {
    outcome: {
      kind: won ? 'win-normal' : 'normal-move',
      roll,
      by: idx,
      steps: totalSteps,
      landing,
      snakeLadderTo,
      capturedPlayer,
      win: won,
    },
    state: {
      ...state,
      players: newPlayers,
      status: won ? 'finished' : 'playing',
      winnerIndex: won ? idx : null,
      currentPlayerIndex: won ? idx : nextPlayerIndex(state),
    },
  };
}

/* ======= STATE VALIDATION ======= */

/**
 * Quick sanity check on game state.
 * @param {object} state
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateState(state) {
  if (!state || !Array.isArray(state.players)) return { valid: false, error: 'Missing players array' };
  if (state.players.length < 2 || state.players.length > 4) {
    return { valid: false, error: `Invalid player count: ${state.players.length}` };
  }
  const slots = new Set();
  for (let i = 0; i < state.players.length; i += 1) {
    const p = state.players[i];
    if (!/^player_[0-3]$/.test(p.slotKey) || slots.has(p.slotKey)) return { valid: false, error: 'Invalid player slot mapping' };
    slots.add(p.slotKey);
    if (!Number.isInteger(p.position) || p.position < 0 || p.position > TOTAL) return { valid: false, error: `Player ${i} has invalid position` };
    if (![0, 6, 12].includes(p.accumulatedSteps)) return { valid: false, error: `Player ${i} has invalid accumulated steps` };
    if (!Number.isInteger(p.consecutiveSixes) || p.consecutiveSixes < 0 || p.consecutiveSixes > 2) return { valid: false, error: `Player ${i} has invalid six count` };
    if (typeof p.won !== 'boolean') return { valid: false, error: `Player ${i} has invalid win state` };
  }
  if (!Number.isInteger(state.currentPlayerIndex) || state.currentPlayerIndex < 0 || state.currentPlayerIndex >= state.players.length) {
    return { valid: false, error: 'Invalid current player' };
  }
  if (state.status !== 'playing' && state.status !== 'finished') return { valid: false, error: 'Invalid game status' };
  if (!Number.isInteger(state.boardIndex) || state.boardIndex < 0 || state.boardIndex > 2) return { valid: false, error: 'Invalid board index' };
  if (state.winnerIndex != null && (!Number.isInteger(state.winnerIndex) || state.winnerIndex < 0 || state.winnerIndex >= state.players.length)) {
    return { valid: false, error: 'Invalid winner' };
  }
  if (state.revision != null && (!Number.isInteger(state.revision) || state.revision < 0)) return { valid: false, error: 'Invalid revision' };
  return { valid: true };
}

/* ======= SERIALIZATION ======= */

/**
 * Serializes state for Firebase storage. All fields stored as plain objects
 * keyed by player_N so Firebase merges work cleanly.
 */
export function serializeState(state) {
  const positions = {}, accumulated = {}, consecutive = {}, won = {};
  state.players.forEach((player) => {
    positions[player.slotKey] = player.position;
    accumulated[player.slotKey] = player.accumulatedSteps;
    consecutive[player.slotKey] = player.consecutiveSixes;
    won[player.slotKey] = player.won;
  });
  return {
    positions,
    accumulated,
    consecutive,
    won,
    currentPlayerKey: state.players[state.currentPlayerIndex].slotKey,
    status: state.status,
    winnerKey: state.winnerIndex != null ? state.players[state.winnerIndex].slotKey : null,
    boardIndex: state.boardIndex || 0,
  };
}

/**
 * Deserializes state from Firebase data + players info.
 * @param {object} gameData — serialized game data from Firebase
 * @param {object} playersData — Firebase players node (player_N: {name, emoji, ...})
 */
export function deserializeState(gameData, playersData) {
  const playerKeys = Object.keys(playersData || {}).filter((key) =>
    /^player_[0-3]$/.test(key) && playersData[key]?.uid
  ).sort();
  const players = playerKeys.map((key, index) => {
    const player = playersData[key];
    return {
      slotKey: key,
      name: player.name || `Player ${index + 1}`,
      emoji: player.emoji || '😀',
      color: player.color || 'red',
      position: gameData.positions?.[key] ?? 0,
      accumulatedSteps: gameData.accumulated?.[key] ?? 0,
      consecutiveSixes: gameData.consecutive?.[key] ?? 0,
      won: gameData.won?.[key] ?? false,
      connected: player.connected !== false,
    };
  });
  const currentPlayerIndex = players.findIndex((player) => player.slotKey === gameData.currentPlayerKey);
  const winnerIndex = gameData.winnerKey == null
    ? null
    : players.findIndex((player) => player.slotKey === gameData.winnerKey);
  return {
    players,
    currentPlayerIndex: currentPlayerIndex >= 0 ? currentPlayerIndex : 0,
    status: gameData.status || 'playing',
    winnerIndex: winnerIndex >= 0 ? winnerIndex : null,
    boardIndex: gameData.boardIndex ?? 0,
    roundId: gameData.roundId ?? null,
    revision: gameData.revision ?? 0,
  };
}

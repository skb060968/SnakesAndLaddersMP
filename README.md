# Snakes & Ladders Multiplayer

Multi-room online Snakes & Ladders with 2-4 players, room codes, emoji avatars, real-time sync via Firebase.

Forked from the original `SnakesAndLadders` project (single-room, with AI mode). This version drops the AI branch and adds proper multi-room scaffolding (create/join/lobby) modeled after the Card Games platform.

## Setup

```bash
npm install
cp .env.example .env  # fill in Firebase credentials
npm run dev
```

## Build

```bash
npm run build
```

## Notes

- Same Firebase project as the other games (Card Games, Tambola, PPP)
- Rooms stored under `snl-rooms/{roomCode}` (separate namespace from other games)
- Room codes are 4 letters (no digits), excluding I and O for clarity
- 2-4 players per room
- Game rules unchanged from the single-room version: 100 squares, exact-roll-to-win, 6 = bonus turn, three sixes = penalty + skip turn

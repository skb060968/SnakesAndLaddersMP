import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AccessToken } from 'livekit-server-sdk';

/**
 * Vercel serverless function: mints a short-lived LiveKit access token for the
 * Snakes & Ladders voice feature.
 *
 * Security:
 * 1. The caller must present a valid Firebase anonymous ID token
 *    (Authorization: Bearer <idToken>). We verify its signature against
 *    Google's public keys ("jose") and check issuer/audience for our Firebase
 *    project.
 * 2. The caller must own the requested seat: we read
 *    <ROOM_NODE>/<code>/players/<identity>/uid through the Realtime Database
 *    REST API with the caller's own ID token, and it must equal the token's
 *    uid. So knowing a room code is not enough to listen in, and nobody can
 *    take over (and kick out) another player's voice identity.
 * The LiveKit token is scoped to the requested room only.
 *
 * Required Vercel env (server-side):
 *   LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
 *   FIREBASE_DATABASE_URL (or VITE_FIREBASE_DATABASE_URL exposed to functions)
 * Optional: FIREBASE_PROJECT_ID (defaults to the app's project).
 */

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'snakes-and-ladders3d';
const ROOM_NODE = 'snl-rooms';
const ROOM_RE = /^[A-HJ-NP-Z]{4}$/;
const IDENTITY_RE = /^player_[0-3]$/;
// Namespaces the LiveKit room per game so different games sharing one LiveKit
// project can never land in the same voice room even with an identical code.
const GAME_RE = /^[a-z][a-z0-9-]{1,15}$/;
const MEMBERSHIP_TIMEOUT_MS = 5000;

const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
);

function sanitizeName(value) {
  return String(value || 'Player').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 16) || 'Player';
}

function databaseUrl() {
  const raw = process.env.FIREBASE_DATABASE_URL || process.env.VITE_FIREBASE_DATABASE_URL || '';
  return raw.trim().replace(/\/+$/, '');
}

// Reads the seat owner's uid with the caller's own ID token, so the database
// rules apply exactly as they do for the client. Returns the stored value
// (null when the seat is empty); throws on network error, timeout or non-200.
async function readSeatUid(dbUrl, code, identity, idToken) {
  const url = `${dbUrl}/${ROOM_NODE}/${code}/players/${identity}/uid.json?auth=${encodeURIComponent(idToken)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEMBERSHIP_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.status !== 200) throw new Error(`membership-status-${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method-not-allowed' });
    return;
  }
  try {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const dbUrl = databaseUrl();
    if (!apiKey || !apiSecret || !dbUrl) {
      res.status(500).json({ error: 'voice-not-configured' });
      return;
    }

    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) {
      res.status(401).json({ error: 'missing-token' });
      return;
    }

    let uid;
    try {
      const { payload } = await jwtVerify(idToken, JWKS, {
        issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
        audience: FIREBASE_PROJECT_ID,
      });
      uid = payload.sub;
      if (!uid) throw new Error('no-subject');
    } catch (_) {
      res.status(401).json({ error: 'invalid-token' });
      return;
    }

    let body;
    try {
      // Vercel's req.body getter throws on malformed JSON, so read it in here.
      const raw = req.body;
      body = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
    } catch (_) {
      body = null;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'invalid-body' });
      return;
    }

    const code = String(body.room || '').toUpperCase();
    const game = String(body.game || '').toLowerCase();
    const identity = String(body.identity || '');
    if (!ROOM_RE.test(code) || !GAME_RE.test(game) || !IDENTITY_RE.test(identity)) {
      res.status(400).json({ error: 'invalid-room-or-identity' });
      return;
    }

    let seatUid;
    try {
      seatUid = await readSeatUid(dbUrl, code, identity, idToken);
    } catch (_) {
      res.status(503).json({ error: 'membership-check-failed' });
      return;
    }
    if (typeof seatUid !== 'string' || seatUid !== uid) {
      res.status(403).json({ error: 'not-in-room' });
      return;
    }

    // Per-game namespaced LiveKit room name.
    const room = `${game}-${code}`;

    const token = new AccessToken(apiKey, apiSecret, {
      identity,
      name: sanitizeName(body.name),
      ttl: '2h',
      metadata: JSON.stringify({ uid }),
    });
    token.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });

    const jwt = await token.toJwt();
    res.status(200).json({ token: jwt });
  } catch (error) {
    res.status(500).json({ error: 'token-failed' });
  }
}

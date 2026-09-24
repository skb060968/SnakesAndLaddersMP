/**
 * Snakes & Ladders MP — 3D board (three.js)
 *
 * Drop-in replacement for the DOM board that used to live in ui.js. Exposes the
 * same function names main.js already calls, so engine.js, firebase-sync.js, the
 * CSS dice cube and the control column are untouched:
 *
 *   buildGrid()                 — mounts the renderer into #board-wrapper (idempotent)
 *   updateTokenSize()           — resizes the canvas / refits the camera
 *   createTokens(colors)        — one pawn per player, in the player's colour
 *   placeTokens(positions)      — snaps pawns to their squares (2/3/4 stacking)
 *   highlightActiveToken(idx)   — pulsing ring + glow under the player to move
 *   animateSteps(...)           — hop-arc per square, `move` sound per hop
 *   animateSnakeOrLadder(...)   — slide down the snake's body / climb the ladder rails
 *   animateCaptureToken(...)    — red glow, fly back to the start pen
 *   setTokenEffect(idx, kind)   — 'penalty' (three sixes) | 'jump' (rolled a six)
 *   setBoardSkin(i)/getBoardIndex() — three colour palettes for the squares
 *
 * Everything is procedural (no model files): a wooden slab with a numbered playing
 * surface under a satin clearcoat, snakes as tapered tubes on seeded Catmull-Rom
 * curves with scale textures, heads, eyes and tongues, ladders as rails + rungs,
 * lathe-turned pawns, one shadow-casting key light and a fixed, tilted camera
 * (kept still so the numbers stay readable on a phone). The canvas is transparent
 * so the page's wood background acts as the table; the slab's shadow falls on it.
 *
 * Square numbering follows the engine: boustrophedon, 1 bottom-left, 10 bottom-right,
 * 100 top-left. "Square 0" (the start pen) is one cell left of square 1, on the frame.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BOARD_SIZE, TOTAL, SNAKES, LADDERS } from './engine.js';
import { playSound } from './ui.js';

/* =================== dimensions (world units: 1 = one square) =================== */
const HALF = BOARD_SIZE / 2;              // playing surface spans ±HALF
const FRAME = 0.7;                        // wooden frame width around the surface
const SLAB_H = 0.5;                       // slab thickness
const SURF_H = 0.06;                      // raised playing surface
const TOP_Y = SURF_H + 0.004;             // where snakes, ladders and pawns rest
const PEN_Y = 0;                          // pawns waiting on "square 0" stand on the frame
const PAWN_S = 1.45;                      // pawn scale (base ≈ 0.6 wide, ≈ 1.05 tall)
const STACK_D = 0.2;                      // offset between pawns sharing a square
const TILT = THREE.MathUtils.degToRad(62);// camera elevation above the board
const STEP_MS = 300;                      // one hop per square (matches the old DOM tempo)

/* =================== deterministic randomness =================== */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = Object.freeze({ wood: 0x5A1AD, snakes: 0x5EA4E, scales: 0x5CA1E });

/* =================== palettes =================== */
const BOARD_SKINS = [
  { name: 'Classic', cells: ['#f7efd8', '#cfe0c0'], border: '#4a3116', num: '#3a2712', finish: '#f1d16a' },
  { name: 'Ivory & Sky', cells: ['#fbf6ea', '#b9d3ec'], border: '#233447', num: '#1e2b38', finish: '#f3cf5c' },
  { name: 'Terracotta', cells: ['#f5e6c4', '#e0a872'], border: '#5f2f0e', num: '#3a1d08', finish: '#f0c75a' },
];
const PAWN_COLOURS = {
  red: 0xd4262c, brown: 0x7b4a2b, yellow: 0xf1c21b,
  green: 0x2f9b41, blue: 0x2761d8, purple: 0x8236b9,
};
// [body, scale highlight] per snake head square — one colour per snake so they read apart.
const SNAKE_COLOURS = {
  99: ['#2f8a3a', '#b9e27c'], 95: ['#c9471d', '#f4b76d'], 89: ['#6a3fb7', '#cbaaf2'],
  66: ['#1a8d97', '#a2e6e0'], 63: ['#b9222f', '#f4a7a0'], 38: ['#c49b12', '#f7e69c'],
  32: ['#2557c6', '#abc8f6'], 20: ['#6c4424', '#d6a575'],
};

/* =================== module state =================== */
let wrapper = null, canvas = null, renderer = null, scene = null, camera = null;
let surfaceMat = null;
const skinTextures = [];
let pawns = [];                 // [{ group, mesh, ring, mat, baseEmissive }]
let currentPositions = [];
let activeIdx = -1;
const snakePaths = new Map();   // head square -> { curve, radiusAt }
const ladderPaths = new Map();  // bottom square -> { a, b, rungs }
const tweens = new Set();
let rafId = 0;
let lowEnd = false;
let maxAniso = 1;
let pawnGeometry = null;
let ringGeometry = null;
const pawnMaterials = new Map();

const BOARD_SKIN_KEY = 'snl_mp_board_skin';
let currentBoardIndex = 0;
try {
  const saved = Number.parseInt(localStorage.getItem(BOARD_SKIN_KEY), 10);
  if (Number.isInteger(saved)) currentBoardIndex = ((saved % BOARD_SKINS.length) + BOARD_SKINS.length) % BOARD_SKINS.length;
} catch (_) {}

/* =================== square geometry =================== */
/** World centre of square n (1..100); n < 1 is the start pen left of square 1. */
function squareCenter(n, out = new THREE.Vector3()) {
  if (n < 1) return out.set(-HALF - 0.5, PEN_Y, HALF - 0.5);
  const r = Math.floor((n - 1) / BOARD_SIZE);           // 0 = bottom row (nearest the camera)
  let c = (n - 1) % BOARD_SIZE;
  if (r % 2 === 1) c = BOARD_SIZE - 1 - c;
  return out.set(c - (HALF - 0.5), TOP_Y, (HALF - 0.5) - r);
}

/**
 * Where each pawn should stand for a positions array. Pawns sharing a square are
 * arranged 2: side by side, 3: triangle, 4: 2×2 — same scheme as the old DOM board.
 */
function layoutPositions(positions) {
  const groups = new Map();
  positions.forEach((p, i) => {
    const k = p < 1 ? 0 : p;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  });
  return positions.map((p, i) => {
    const k = p < 1 ? 0 : p;
    const g = groups.get(k);
    const j = g.indexOf(i);
    const c = squareCenter(k);
    const d = STACK_D;
    let dx = 0, dz = 0;
    if (g.length === 2) dx = j === 0 ? -d : d;
    else if (g.length === 3) { [dx, dz] = [[-d, -d * 0.6], [d, -d * 0.6], [0, d * 0.7]][j]; }
    else if (g.length >= 4) { [dx, dz] = [[-d, -d], [d, -d], [-d, d], [d, d]][j % 4]; }
    c.x += dx; c.z += dz;
    return c;
  });
}

/* =================== procedural textures =================== */
function canvasTexture(w, h, draw, opts = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(opts.anisotropy || 8, maxAniso);
  if (opts.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...opts.repeat); }
  return t;
}

/** Warm walnut with wavy grain; tiles on the slab's top and sides. */
function woodTexture() {
  const rng = seeded(SEED.wood);
  return canvasTexture(1024, 1024, (ctx, W, H) => {
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, '#7d4b22'); g.addColorStop(0.5, '#93582a'); g.addColorStop(1, '#7a4720');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 320; i += 1) {
      const y0 = rng() * H, amp = 3 + rng() * 9, freq = 0.004 + rng() * 0.006, phase = rng() * 6.28;
      ctx.strokeStyle = `rgba(${rng() < 0.7 ? '38,18,6' : '210,150,90'},${0.05 + rng() * 0.16})`;
      ctx.lineWidth = 0.6 + rng() * 2.6;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 8) {
        const y = y0 + Math.sin(x * freq + phase) * amp;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (let i = 0; i < 6; i += 1) {                     // a few soft knots
      const x = rng() * W, y = rng() * H, r = 18 + rng() * 30;
      const k = ctx.createRadialGradient(x, y, 2, x, y, r);
      k.addColorStop(0, 'rgba(50,24,8,0.45)'); k.addColorStop(1, 'rgba(50,24,8,0)');
      ctx.fillStyle = k; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }, { repeat: [2, 2] });
}

/** The numbered 10×10 playing surface for one palette. Row 1 is drawn at the bottom. */
function boardTexture(skin) {
  const W = lowEnd ? 1024 : 2048;
  const cs = W / BOARD_SIZE;
  return canvasTexture(W, W, (ctx) => {
    ctx.fillStyle = skin.border; ctx.fillRect(0, 0, W, W);
    for (let r = 0; r < BOARD_SIZE; r += 1) {
      for (let c = 0; c < BOARD_SIZE; c += 1) {
        const n = r * BOARD_SIZE + (r % 2 === 0 ? c + 1 : BOARD_SIZE - c);
        const x = c * cs, y = (BOARD_SIZE - 1 - r) * cs;
        ctx.fillStyle = n === TOTAL ? skin.finish : skin.cells[(r + c) % 2];
        ctx.fillRect(x, y, cs, cs);
        // soft inner shading so each square reads as a tile
        const v = ctx.createRadialGradient(x + cs / 2, y + cs / 2, cs * 0.25, x + cs / 2, y + cs / 2, cs * 0.78);
        v.addColorStop(0, 'rgba(255,255,255,0.10)'); v.addColorStop(1, 'rgba(0,0,0,0.13)');
        ctx.fillStyle = v; ctx.fillRect(x, y, cs, cs);
        ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = Math.max(2, cs * 0.012);
        ctx.strokeRect(x + 1, y + 1, cs - 2, cs - 2);
        // number: upper-centre so a standing pawn hides as little of it as possible
        ctx.font = `700 ${Math.round(cs * 0.40)}px "Trebuchet MS", "Segoe UI", Arial, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillText(String(n), x + cs / 2 + cs * 0.012, y + cs * 0.40 + cs * 0.012);
        ctx.fillStyle = skin.num;
        ctx.fillText(String(n), x + cs / 2, y + cs * 0.40);
        if (n === TOTAL) {
          ctx.font = `${Math.round(cs * 0.30)}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
          ctx.fillText('🏆', x + cs / 2, y + cs * 0.76);
        }
      }
    }
    ctx.strokeStyle = skin.border; ctx.lineWidth = Math.max(6, cs * 0.06);
    ctx.strokeRect(0, 0, W, W);
  });
}

/** Snake skin: overlapping scales in two tones with a paler belly band (v ≈ 0.75). */
function snakeTexture(dark, light) {
  const rng = seeded(SEED.scales);
  return canvasTexture(256, 128, (ctx, W, H) => {
    // Body colour stays dominant: scales are the body tone with a faint highlight
    // and a dark outline; only the belly band and dorsal stripe use the light tone.
    ctx.fillStyle = dark; ctx.fillRect(0, 0, W, H);
    const sw = 20, sh = 14;
    for (let row = -1; row < H / sh + 1; row += 1) {
      const off = row % 2 ? sw / 2 : 0;
      for (let x = -sw; x < W + sw; x += sw) {
        ctx.beginPath();
        ctx.arc(x + off, row * sh, sw * 0.6, 0, Math.PI * 2);
        ctx.fillStyle = dark; ctx.fill();
        ctx.fillStyle = light; ctx.globalAlpha = 0.10 + rng() * 0.14; ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1.6; ctx.stroke();
      }
    }
    // belly plates
    const b0 = H * 0.69, b1 = H * 0.82;
    ctx.fillStyle = 'rgba(245,230,190,0.6)'; ctx.fillRect(0, b0, W, b1 - b0);
    ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1.2;
    for (let x = 0; x < W; x += 12) { ctx.beginPath(); ctx.moveTo(x, b0); ctx.lineTo(x, b1); ctx.stroke(); }
    // dorsal diamonds
    ctx.fillStyle = light; ctx.globalAlpha = 0.55;
    for (let x = 8; x < W; x += 32) {
      ctx.beginPath(); ctx.moveTo(x, H * 0.16); ctx.lineTo(x + 9, H * 0.25); ctx.lineTo(x, H * 0.34); ctx.lineTo(x - 9, H * 0.25); ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, { repeat: [1, 1] });
}

/** Transparent "START" decal for the pen on the frame. */
function startTexture() {
  return canvasTexture(256, 256, (ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,240,200,0.92)';
    ctx.font = '700 60px "Trebuchet MS", "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('START', W / 2, H * 0.40);
    ctx.font = '700 84px Arial, sans-serif';
    ctx.fillText('➜', W / 2, H * 0.74);
  });
}

/* =================== geometry helpers =================== */
/**
 * Tube of varying radius along a curve, resting on the surface (ring centre is lifted
 * by its own radius). Frames are built from the world up-vector so the skin never twists.
 */
function taperedTube(curve, radiusAt, segs, radial, uPerUnit) {
  const pos = [], nor = [], uv = [], idx = [];
  const p = new THREE.Vector3(), T = new THREE.Vector3(), S = new THREE.Vector3(), n = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const length = curve.getLength();
  for (let i = 0; i <= segs; i += 1) {
    const t = i / segs;
    curve.getPointAt(t, p);
    curve.getTangentAt(t, T); T.y = 0; T.normalize();
    S.crossVectors(T, UP).normalize();
    const r = radiusAt(t);
    const cy = p.y + r;
    for (let j = 0; j <= radial; j += 1) {
      const a = (j / radial) * Math.PI * 2;
      n.copy(S).multiplyScalar(Math.cos(a)).addScaledVector(UP, Math.sin(a));
      pos.push(p.x + n.x * r, cy + n.y * r, p.z + n.z * r);
      nor.push(n.x, n.y, n.z);
      uv.push(t * length * uPerUnit, j / radial);
    }
  }
  for (let i = 0; i < segs; i += 1) {
    for (let j = 0; j < radial; j += 1) {
      const a = i * (radial + 1) + j, b = a + radial + 1, c = a + 1, d = b + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

const UNIT_CYL = new THREE.CylinderGeometry(1, 1, 1, 12, 1);
/** A cylinder of radius r joining points a and b. */
function rod(a, b, r, mat) {
  const m = new THREE.Mesh(UNIT_CYL, mat);
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  m.scale.set(r, len, r);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

/* =================== scene construction =================== */
function buildScene() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, 0.5, 80);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;
  pmrem.dispose();

  scene.add(new THREE.HemisphereLight(0xe9f0ff, 0x6b4a2c, 0.8));
  const key = new THREE.DirectionalLight(0xfff1dc, 2.3);
  key.position.set(-5.5, 11, 6.5);
  key.castShadow = true;
  key.shadow.mapSize.set(lowEnd ? 1024 : 2048, lowEnd ? 1024 : 2048);
  key.shadow.camera.near = 2; key.shadow.camera.far = 30;
  key.shadow.camera.left = -8; key.shadow.camera.right = 8;
  key.shadow.camera.top = 8; key.shadow.camera.bottom = -8;
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.03;
  scene.add(key, key.target);

  // Shadow catcher: invisible except where the slab shadows the page's wood background.
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.35 }));
  catcher.rotation.x = -Math.PI / 2; catcher.position.y = -SLAB_H; catcher.receiveShadow = true;
  scene.add(catcher);

  // Wooden slab (frame)
  const slabMat = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.55, metalness: 0 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(2 * (HALF + FRAME), SLAB_H, 2 * (HALF + FRAME)), slabMat);
  slab.position.y = -SLAB_H / 2; slab.castShadow = true; slab.receiveShadow = true;
  scene.add(slab);

  // Raised playing surface: dark edge box + numbered top under a satin clearcoat
  const edge = new THREE.Mesh(
    new THREE.BoxGeometry(2 * HALF + 0.16, SURF_H, 2 * HALF + 0.16),
    new THREE.MeshStandardMaterial({ color: 0x3a2812, roughness: 0.6 }),
  );
  edge.position.y = SURF_H / 2; edge.castShadow = true; edge.receiveShadow = true;
  scene.add(edge);
  surfaceMat = new THREE.MeshPhysicalMaterial({
    map: skinTexture(currentBoardIndex), roughness: 0.42, metalness: 0,
    clearcoat: 0.55, clearcoatRoughness: 0.28,
  });
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(2 * HALF, 2 * HALF), surfaceMat);
  surface.rotation.x = -Math.PI / 2; surface.position.y = SURF_H + 0.004; surface.receiveShadow = true;
  scene.add(surface);

  // Start pen decal on the frame, left of square 1
  const pen = squareCenter(0);
  const decal = new THREE.Mesh(
    new THREE.PlaneGeometry(0.82, 0.82),
    new THREE.MeshBasicMaterial({ map: startTexture(), transparent: true, depthWrite: false }),
  );
  decal.rotation.x = -Math.PI / 2; decal.position.set(pen.x, 0.003, pen.z);
  scene.add(decal);

  buildSnakes();
  buildLadders();

  pawnGeometry = new THREE.LatheGeometry(
    [[0, 0], [0.20, 0], [0.21, 0.03], [0.17, 0.07], [0.12, 0.10], [0.09, 0.20], [0.07, 0.30],
      [0.11, 0.36], [0.07, 0.42], [0.12, 0.48], [0.135, 0.56], [0.11, 0.64], [0.06, 0.70], [0, 0.72]]
      .map(([r, y]) => new THREE.Vector2(r * PAWN_S, y * PAWN_S)),
    28,
  );
  ringGeometry = new THREE.TorusGeometry(0.27 * PAWN_S, 0.035, 10, 40);
}

function buildSnakes() {
  const rng = seeded(SEED.snakes);
  const heads = Object.keys(SNAKES).map(Number).sort((a, b) => b - a);
  heads.forEach((head) => {
    const tail = SNAKES[head];
    const a = squareCenter(head), b = squareCenter(tail);
    const dir = new THREE.Vector3().subVectors(b, a); dir.y = 0;
    const len = dir.length(); dir.normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    // Head sits at the head square, body wriggles to the tail square with 3 seeded bends.
    const pts = [a.clone()];
    let sign = rng() < 0.5 ? -1 : 1;
    for (let k = 1; k <= 3; k += 1) {
      const t = k / 4;
      const amp = Math.min(0.9, 0.25 + len * 0.09) * (0.6 + rng() * 0.6) * sign;
      sign = -sign;
      const p = a.clone().addScaledVector(dir, len * t).addScaledVector(side, amp);
      p.x = THREE.MathUtils.clamp(p.x, -HALF + 0.3, HALF - 0.3);
      p.z = THREE.MathUtils.clamp(p.z, -HALF + 0.3, HALF - 0.3);
      pts.push(p);
    }
    pts.push(b.clone());
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    // Thick through the body, tapering to a point only over the last third.
    const radiusAt = (t) => 0.025 + 0.19 * Math.pow(1 - t, 0.75);
    snakePaths.set(head, { curve, radiusAt });

    const [dark, light] = SNAKE_COLOURS[head] || ['#3c8a3a', '#b7e07a'];
    const skin = snakeTexture(dark, light);
    const mat = new THREE.MeshPhysicalMaterial({ map: skin, roughness: 0.45, clearcoat: 0.35, clearcoatRoughness: 0.4 });
    const body = new THREE.Mesh(taperedTube(curve, radiusAt, 140, 14, 1 / 0.42), mat);
    body.castShadow = true; body.receiveShadow = true;
    scene.add(body);

    // Head: flattened sphere facing away from the body, with eyes and a forked tongue.
    const headR = radiusAt(0) * 1.12;
    const tangent = curve.getTangentAt(0); tangent.y = 0; tangent.normalize();
    const headGroup = new THREE.Group();
    const headPos = a.clone().addScaledVector(tangent, -headR * 0.9);
    headGroup.position.set(headPos.x, TOP_Y + headR * 0.72, headPos.z);
    headGroup.lookAt(headPos.x - tangent.x, TOP_Y + headR * 0.72, headPos.z - tangent.z);
    const headGeo = new THREE.SphereGeometry(headR, 22, 16); headGeo.scale(1.25, 0.72, 1.55);
    const headMesh = new THREE.Mesh(headGeo, new THREE.MeshPhysicalMaterial({ color: dark, roughness: 0.4, clearcoat: 0.4 }));
    headMesh.castShadow = true;
    headGroup.add(headMesh);
    const eyeGeo = new THREE.SphereGeometry(headR * 0.22, 12, 10);
    const pupilGeo = new THREE.SphereGeometry(headR * 0.11, 10, 8);
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0xfff4c8, roughness: 0.2 });
    const pupilMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.3 });
    [-1, 1].forEach((s) => {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(s * headR * 0.62, headR * 0.45, headR * 0.85);
      const pupil = new THREE.Mesh(pupilGeo, pupilMat);
      pupil.position.set(s * headR * 0.66, headR * 0.47, headR * 1.03);
      headGroup.add(eye, pupil);
    });
    const tongueMat = new THREE.MeshStandardMaterial({ color: 0xe0203a, roughness: 0.5 });
    const tongue = new THREE.Mesh(new THREE.BoxGeometry(headR * 0.14, headR * 0.06, headR * 0.9), tongueMat);
    tongue.position.set(0, -headR * 0.15, headR * 1.75);
    headGroup.add(tongue);
    [-1, 1].forEach((s) => {
      const fork = new THREE.Mesh(new THREE.BoxGeometry(headR * 0.1, headR * 0.05, headR * 0.4), tongueMat);
      fork.position.set(s * headR * 0.12, -headR * 0.15, headR * 2.3);
      fork.rotation.y = -s * 0.5;
      headGroup.add(fork);
    });
    scene.add(headGroup);
  });
}

function buildLadders() {
  const woodMat = new THREE.MeshStandardMaterial({ color: 0xd9a35f, roughness: 0.6, metalness: 0 });
  const railR = 0.048, rungR = 0.034, halfW = 0.2;
  Object.keys(LADDERS).map(Number).forEach((bottom) => {
    const top = LADDERS[bottom];
    const a = squareCenter(bottom), b = squareCenter(top);
    // Rails rest on the board at the foot and lift a little toward the top so the
    // ladder reads as leaning rather than painted on.
    a.y = TOP_Y + railR; b.y = TOP_Y + railR + 0.2;
    const dir = new THREE.Vector3().subVectors(b, a); dir.y = 0; dir.normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(halfW);
    const group = new THREE.Group();
    group.add(rod(a.clone().add(side), b.clone().add(side), railR, woodMat));
    group.add(rod(a.clone().sub(side), b.clone().sub(side), railR, woodMat));
    const len = a.distanceTo(b);
    const rungs = Math.max(2, Math.round(len / 0.5));
    for (let i = 0; i <= rungs; i += 1) {
      const t = (i + 0.5) / (rungs + 1);
      const c = new THREE.Vector3().lerpVectors(a, b, t);
      group.add(rod(c.clone().add(side), c.clone().sub(side), rungR, woodMat));
    }
    scene.add(group);
    ladderPaths.set(bottom, { a, b, rungs });
  });
}

/* =================== mount / resize / loop =================== */
function resize() {
  if (!renderer || !wrapper) return;
  const w = wrapper.clientWidth, h = wrapper.clientHeight;
  if (w < 2 || h < 2) return;                      // gameplay screen hidden
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  fitCamera();
}

/**
 * Fixed tilted camera: aim at the board centre and pull back until the whole slab
 * (plus pawn headroom on the far row) fits the canvas with a small margin.
 */
function fitCamera() {
  const dir = new THREE.Vector3(0, Math.sin(TILT), Math.cos(TILT)).normalize();
  const target = new THREE.Vector3(0, 0, 0.3);
  const e = HALF + FRAME + 0.05;
  const corners = [
    [-e, 0, e], [e, 0, e], [-e, 0, -e], [e, 0, -e],
    [-e, 0.9, -e], [e, 0.9, -e], [-e, -SLAB_H, e], [e, -SLAB_H, e],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
  let dist = 16;
  const v = new THREE.Vector3();
  for (let it = 0; it < 10; it += 1) {
    camera.position.copy(target).addScaledVector(dir, dist);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    let m = 0;
    corners.forEach((c) => { v.copy(c).project(camera); m = Math.max(m, Math.abs(v.x), Math.abs(v.y)); });
    if (Math.abs(m - 0.985) < 0.003) break;
    dist *= m / 0.985;
  }
}

function frame(now) {
  rafId = requestAnimationFrame(frame);
  tickTweens(now);
  idle(now);
  if (document.hidden || !canvas || canvas.width === 0) return;
  renderer.render(scene, camera);
}

/** Per-frame ambience: the active pawn's ring breathes and its body glows. */
function idle(now) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 190);
  pawns.forEach((p, i) => {
    const on = i === activeIdx;
    p.ring.visible = on;
    if (on) {
      p.ring.material.opacity = 0.55 + 0.45 * pulse;
      const s = 1 + 0.12 * pulse;
      p.ring.scale.set(s, s, 1);
      if (!p.effect) p.mat.emissiveIntensity = 0.12 + 0.28 * pulse;
    } else if (!p.effect) {
      p.mat.emissiveIntensity = 0;
    }
  });
}

/* =================== tweens =================== */
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const linear = (t) => t;

/**
 * Time-based tween driven by the render loop. A timer backstop finishes it even if
 * rAF is throttled (tab in background), so gameplay promises always resolve.
 */
function tween(duration, update, ease = easeInOut) {
  return new Promise((resolve) => {
    const tw = { start: performance.now(), duration, update, ease, done: false, resolve };
    tw.timer = setTimeout(() => finishTween(tw), duration + 60);
    tweens.add(tw);
  });
}
function finishTween(tw) {
  if (tw.done) return;
  tw.done = true;
  clearTimeout(tw.timer);
  tweens.delete(tw);
  try { tw.update(1, 1); } catch (_) {}
  tw.resolve();
}
function tickTweens(now) {
  tweens.forEach((tw) => {
    const t = Math.min(1, (now - tw.start) / tw.duration);
    tw.update(tw.ease(t), t);
    if (t >= 1) finishTween(tw);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* =================== pawn helpers =================== */
function pawnMaterial(colorId) {
  if (!pawnMaterials.has(colorId)) {
    pawnMaterials.set(colorId, new THREE.MeshPhysicalMaterial({
      color: PAWN_COLOURS[colorId] ?? PAWN_COLOURS.red,
      roughness: 0.32, metalness: 0, clearcoat: 0.85, clearcoatRoughness: 0.18,
      emissive: 0xffffff, emissiveIntensity: 0,
    }));
  }
  // Each pawn gets its own clone so glow/penalty effects don't bleed between players.
  return pawnMaterials.get(colorId).clone();
}

/** Arc hop from the pawn's current spot to `target` (Vector3), height in world units. */
function hopTo(idx, target, duration, height) {
  const p = pawns[idx];
  if (!p) return Promise.resolve();
  const from = p.group.position.clone();
  return tween(duration, (e, t) => {
    p.group.position.lerpVectors(from, target, e);
    p.group.position.y += Math.sin(Math.PI * t) * height;
    // tiny squash-and-stretch
    const s = 1 + 0.10 * Math.sin(Math.PI * t);
    p.group.scale.set(1 / Math.sqrt(s), s, 1 / Math.sqrt(s));
  }, easeInOut).then(() => { p.group.scale.set(1, 1, 1); p.group.position.copy(target); });
}

/** Slide every pawn except `except` to its layout spot (stacking may have changed). */
function settleOthers(targets, except) {
  targets.forEach((tgt, i) => {
    if (i === except || !pawns[i]) return;
    if (pawns[i].group.position.distanceToSquared(tgt) < 1e-6) return;
    const from = pawns[i].group.position.clone();
    tween(220, (e) => { pawns[i].group.position.lerpVectors(from, tgt, e); }, easeOut);
  });
}

/* =================== public API (same names as the old DOM board) =================== */

/** Mounts the 3D board into #board-wrapper. Safe to call again on Play Again. */
export function buildGrid() {
  wrapper = document.getElementById('board-wrapper');
  if (!wrapper) return;
  if (renderer) {
    if (canvas && !canvas.isConnected) wrapper.appendChild(canvas);
    resize();
    return;
  }
  wrapper.querySelectorAll('#board-img, #grid, .token, .board-fallback').forEach((el) => el.remove());
  canvas = wrapper.querySelector('#board-canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'board-canvas';
    canvas.className = 'board-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    wrapper.appendChild(canvas);
  }

  lowEnd = (navigator.deviceMemory && navigator.deviceMemory <= 2) ||
    (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) || false;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (err) {
    console.error('3D board unavailable:', err);
    canvas.remove(); canvas = null;
    const note = document.createElement('p');
    note.className = 'board-fallback';
    note.textContent = 'Your browser could not start the 3D board.';
    wrapper.appendChild(note);
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowEnd ? 1.5 : 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  maxAniso = renderer.capabilities.getMaxAnisotropy();

  buildScene();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => resize()).observe(wrapper);
  resize();
  if (!rafId) rafId = requestAnimationFrame(frame);
}

/** Kept for API compatibility: re-measures the wrapper and refits the camera. */
export function updateTokenSize() {
  requestAnimationFrame(resize);
}

/** One pawn per player. Idempotent — removes existing pawns first. */
export function createTokens(colors) {
  if (!scene) buildGrid();
  if (!scene) return;
  pawns.forEach((p) => { scene.remove(p.group); p.mat.dispose(); p.ring.material.dispose(); });
  pawns = [];
  currentPositions = colors.map(() => 0);
  activeIdx = -1;
  colors.forEach((colorId, i) => {
    const group = new THREE.Group();
    const mat = pawnMaterial(colorId || 'red');
    const mesh = new THREE.Mesh(pawnGeometry, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    const ring = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({
      color: 0xfff3b0, transparent: true, opacity: 0.8, depthWrite: false,
    }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.012; ring.visible = false;
    group.add(mesh, ring);
    group.name = `token${i}`;
    scene.add(group);
    pawns.push({ group, mesh, ring, mat, effect: null });
  });
  placeTokens(currentPositions);
}

/** Snaps every pawn to its square (with 2/3/4 stacking offsets). */
export function placeTokens(positions) {
  if (!pawns.length) return;
  currentPositions = positions.slice();
  const targets = layoutPositions(positions);
  targets.forEach((tgt, i) => { if (pawns[i]) pawns[i].group.position.copy(tgt); });
}

export function highlightActiveToken(idx) {
  activeIdx = idx;
}

/**
 * Transient token effects driven by main.js: 'penalty' (three sixes — red flash and
 * shake) or 'jump' (rolled a six — celebratory hop).
 */
export function setTokenEffect(idx, kind) {
  const p = pawns[idx];
  if (!p) return Promise.resolve();
  if (kind === 'jump') {
    const base = p.group.position.clone();
    return tween(600, (e, t) => {
      p.group.position.y = base.y + Math.sin(Math.PI * t) * 0.55;
    }, linear).then(() => { p.group.position.copy(base); });
  }
  if (kind === 'penalty') return flash(p, 0xff2020, 1500, true);
  return Promise.resolve();
}

/** Emissive flash (and optional shake) on a pawn for `ms`. */
function flash(p, colour, ms, shake) {
  p.effect = 'flash';
  p.mat.emissive.setHex(colour);
  const base = p.group.position.clone();
  return tween(ms, (e, t) => {
    p.mat.emissiveIntensity = 0.9 * Math.abs(Math.sin(t * Math.PI * 3));
    if (shake) p.group.position.x = base.x + Math.sin(t * 60) * 0.05 * (1 - t);
  }, linear).then(() => {
    if (shake) p.group.position.x = base.x;
    p.mat.emissive.setHex(0xffffff);
    p.mat.emissiveIntensity = 0;
    p.effect = null;
  });
}

/**
 * Hops a pawn forward `steps` squares, one arc per square, playing the move sound
 * on each hop. Mutates currentPositions[playerIdx] as it goes (same contract as
 * the old DOM version). Adds the same 320 ms settle when the pawn reaches 100.
 */
export async function animateSteps(playerIdx, steps, currentPos) {
  if (steps <= 0 || !pawns[playerIdx]) return;
  for (let s = 0; s < steps; s += 1) {
    currentPos[playerIdx] = Math.min(TOTAL, currentPos[playerIdx] + 1);
    const targets = layoutPositions(currentPos);
    playSound('move');
    settleOthers(targets, playerIdx);
    await hopTo(playerIdx, targets[playerIdx], STEP_MS, 0.55);
  }
  currentPositions = currentPos.slice();
  if (currentPos[playerIdx] === TOTAL) await wait(320);
}

/**
 * Snake: 500 ms hit (red flash + shake) then the pawn rides the snake's body from
 * head to tail. Ladder: 500 ms hit (gold flash + bounce) then climbs the rails,
 * bobbing over each rung. Falls back to a plain arc if no path matches.
 */
export async function animateSnakeOrLadder(playerIdx, targetCell, type, currentPos) {
  const p = pawns[playerIdx];
  if (!p) return;
  const startCell = currentPos[playerIdx];
  playSound(type === 'ladder' ? 'ladder' : 'snake');

  if (type === 'snake') {
    await flash(p, 0xff3030, 500, true);
  } else {
    const base = p.group.position.clone();
    p.effect = 'flash';
    p.mat.emissive.setHex(0xffd700);
    await tween(500, (e, t) => {
      p.mat.emissiveIntensity = 0.9 * Math.abs(Math.sin(t * Math.PI * 2));
      p.group.position.y = base.y + Math.abs(Math.sin(t * Math.PI * 2)) * 0.25;
    }, linear);
    p.group.position.copy(base);
    p.mat.emissive.setHex(0xffffff); p.mat.emissiveIntensity = 0; p.effect = null;
  }

  const snake = type === 'snake' ? snakePaths.get(startCell) : null;
  const ladder = type === 'ladder' ? ladderPaths.get(startCell) : null;
  const from = p.group.position.clone();

  if (snake) {
    const pt = new THREE.Vector3();
    // Blend from the pawn's stacked spot onto the head, then ride the tube down.
    await tween(1200, (e, t) => {
      snake.curve.getPointAt(e, pt);
      const lift = TOP_Y + snake.radiusAt(e) * 2 + 0.01;
      const blend = Math.min(1, t * 6);
      p.group.position.set(
        from.x + (pt.x - from.x) * blend,
        lift + (from.y - lift) * (1 - blend),
        from.z + (pt.z - from.z) * blend,
      );
    }, easeInOut);
  } else if (ladder) {
    const lp = new THREE.Vector3();
    await tween(1100, (e, t) => {
      lp.lerpVectors(ladder.a, ladder.b, e);
      const blend = Math.min(1, t * 6);
      const bob = Math.abs(Math.sin(e * Math.PI * (ladder.rungs + 1))) * 0.07;
      p.group.position.set(
        from.x + (lp.x - from.x) * blend,
        lp.y + 0.05 + bob,
        from.z + (lp.z - from.z) * blend,
      );
    }, linear);
  } else {
    const end = squareCenter(targetCell);
    await tween(600, (e, t) => {
      p.group.position.lerpVectors(from, end, e);
      p.group.position.y += Math.sin(Math.PI * t) * 0.8;
    });
  }

  currentPos[playerIdx] = targetCell;
  const targets = layoutPositions(currentPos);
  settleOthers(targets, playerIdx);
  await hopTo(playerIdx, targets[playerIdx], 220, 0.15);
  currentPositions = currentPos.slice();
}

/** Captured pawn glows red and flies back to the start pen. */
export async function animateCaptureToken(capturedIdx, currentPos) {
  const p = pawns[capturedIdx];
  if (!p) return;
  if (currentPos[capturedIdx] === 0) return;
  const glow = flash(p, 0xff2020, 1050, false);
  currentPos[capturedIdx] = 0;
  const targets = layoutPositions(currentPos);
  settleOthers(targets, capturedIdx);
  await hopTo(capturedIdx, targets[capturedIdx], 750, 1.1);
  currentPositions = currentPos.slice();
  await glow;
}

/* =================== board skins =================== */
/** Skin textures are drawn on first use (each is a 2048² canvas). */
function skinTexture(i) {
  if (!skinTextures[i]) skinTextures[i] = boardTexture(BOARD_SKINS[i]);
  return skinTextures[i];
}

export function setBoardSkin(index) {
  currentBoardIndex = ((index % BOARD_SKINS.length) + BOARD_SKINS.length) % BOARD_SKINS.length;
  try { localStorage.setItem(BOARD_SKIN_KEY, String(currentBoardIndex)); } catch (_) {}
  if (surfaceMat) {
    surfaceMat.map = skinTexture(currentBoardIndex);
    surfaceMat.needsUpdate = true;
  }
}

export function getBoardIndex() { return currentBoardIndex; }

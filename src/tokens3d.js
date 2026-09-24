/**
 * Snakes & Ladders MP â€” 3D token layer (three.js)
 *
 * A transparent WebGL canvas laid over the untouched 2D board. Only the player
 * tokens live here: lathe-turned pawns in solid player colours, lit with one
 * shadow-casting key light so each pawn drops a soft shadow onto the board PNG.
 *
 * The camera is orthographic and tilted ~38Â° so pawns show their profile, yet
 * the board plane still maps 1:1 to CSS pixels: ui.js hands over pixel centres
 * (relative to #board-wrapper) exactly as it did for the DOM tokens, and this
 * module converts them to world space (x = px, z = py / sin(elevation)).
 *
 * Pawn bodies never change colour. Turn and hit feedback is a ring on the
 * board under the pawn: gold pulse for the active player, red flash for a
 * snake bite / three sixes / capture, gold flash for a ladder.
 *
 * API (all pixel coordinates are wrapper-relative CSS px):
 *   mount(wrapperEl)                          â†’ boolean (false if WebGL failed)
 *   setTokens(colorIds)                       one pawn per player (idempotent)
 *   setTokenSize(px)                          scales pawns to the current cell size
 *   moveToken(idx, x, y, {duration, hop})     â†’ Promise; duration 0 snaps
 *   setActiveToken(idx)
 *   playEffect(idx, kind)                     â†’ Promise; 'jump'|'penalty'|'snake-hit'|'ladder-hit'
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const ELEV = THREE.MathUtils.degToRad(60);   // camera elevation above the board (90 = top-down disc, lower = more profile)
const SIN = Math.sin(ELEV);
const PAWN_H = 2.1;                          // pawn height in token-size units
const BASE_DOWN = 0.28;                      // base sits below the cell centre so the visible mass is centred
const CANVAS_BLEED = 0.06;                   // canvas extends 6% past the wrapper on every side (see style.css)

const COLOURS = {
  red: 0xd4262c, brown: 0x7b4a2b, yellow: 0xf1c21b,
  green: 0x2f9b41, blue: 0x2761d8, purple: 0x8236b9,
};
const RING = { active: 0xffd54a, red: 0xff2a2a, gold: 0xffd700 };

let wrapper = null, canvas = null, renderer = null, scene = null, camera = null, key = null, catcher = null;
let pawnGeo = null, ringGeo = null;
let pawns = [];               // [{ group, mesh, ring, ringMat, px, py, move, effect }]
let tokenPx = 22;
let activeIdx = -1;
let rafId = 0;
let W = 1, H = 1, offX = 0, offY = 0;
const tweens = new Set();
let resizeObserver = null;

/* =================== tweens =================== */
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
const linear = (t) => t;

/** Time-based tween on the render loop with a timer backstop (rAF may be throttled). */
function tween(duration, update, ease = easeInOut) {
  let handle;
  const promise = new Promise((resolve) => {
    handle = { start: performance.now(), duration, update, ease, done: false, resolve };
    handle.timer = setTimeout(() => finishTween(handle), duration + 80);
    tweens.add(handle);
  });
  promise.handle = handle;
  return promise;
}
function finishTween(tw) {
  if (tw.done) return;
  tw.done = true;
  clearTimeout(tw.timer);
  tweens.delete(tw);
  try { tw.update(1, 1); } catch (_) {}
  tw.resolve();
}
function cancelTween(tw) {
  if (!tw || tw.done) return;
  tw.done = true;
  clearTimeout(tw.timer);
  tweens.delete(tw);
  tw.resolve();
}
function tickTweens(now) {
  tweens.forEach((tw) => {
    const t = Math.min(1, (now - tw.start) / tw.duration);
    tw.update(tw.ease(t), t);
    if (t >= 1) finishTween(tw);
  });
}

/* =================== coordinates =================== */
/** Wrapper-relative pixel â†’ world point on the board plane. */
function toWorld(px, py, out = new THREE.Vector3()) {
  return out.set(px + offX, 0, (py + offY) / SIN);
}

/* =================== mount / resize / loop =================== */
export function mount(wrapperEl) {
  if (renderer) {
    if (wrapper !== wrapperEl) {
      wrapper = wrapperEl;
      wrapper.appendChild(canvas);
      resize();
    } else if (!canvas.isConnected) {
      wrapper.appendChild(canvas);
      resize();
    }
    return true;
  }
  wrapper = wrapperEl;
  canvas = document.createElement('canvas');
  canvas.className = 'token-layer';
  canvas.setAttribute('aria-hidden', 'true');
  wrapper.appendChild(canvas);
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (err) {
    console.error('3D tokens unavailable:', err);
    canvas.remove(); canvas = null; renderer = null;
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.5;
  pmrem.dispose();

  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 8000);
  camera.up.set(0, 1, 0);

  scene.add(new THREE.HemisphereLight(0xf2f5ff, 0x8a6a48, 0.75));
  key = new THREE.DirectionalLight(0xfff3e0, 2.2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.6;
  scene.add(key, key.target);

  // Invisible plane that only shows the pawns' shadows over the board image.
  catcher = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.38 }));
  catcher.rotation.x = -Math.PI / 2;
  catcher.receiveShadow = true;
  scene.add(catcher);

  // Unit pawn: height 1, base radius 0.3 (scaled per token size).
  pawnGeo = new THREE.LatheGeometry(
    [[0, 0], [0.30, 0], [0.31, 0.04], [0.27, 0.09], [0.18, 0.13], [0.135, 0.27], [0.105, 0.41],
      [0.15, 0.49], [0.10, 0.57], [0.16, 0.66], [0.185, 0.77], [0.15, 0.88], [0.08, 0.96], [0, 1]]
      .map(([r, y]) => new THREE.Vector2(r, y)),
    32,
  );
  ringGeo = new THREE.TorusGeometry(0.5, 0.1, 10, 48);

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => resize());
    resizeObserver.observe(wrapper);
  }
  resize();
  if (!rafId) rafId = requestAnimationFrame(frame);
  return true;
}

function resize() {
  if (!renderer || !canvas) return;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (cw < 2 || ch < 2) return;                    // gameplay screen hidden
  W = cw; H = ch;
  offX = wrapper.clientWidth * CANVAS_BLEED;
  offY = wrapper.clientHeight * CANVAS_BLEED;
  renderer.setSize(W, H, false);

  const center = new THREE.Vector3(W / 2, 0, H / (2 * SIN));
  camera.left = -W / 2; camera.right = W / 2; camera.top = H / 2; camera.bottom = -H / 2;
  camera.position.copy(center).add(new THREE.Vector3(0, Math.sin(ELEV), Math.cos(ELEV)).multiplyScalar(3000));
  camera.lookAt(center);
  camera.updateProjectionMatrix();

  key.position.copy(center).add(new THREE.Vector3(-0.55, 1.0, 0.45).normalize().multiplyScalar(2000));
  key.target.position.copy(center);
  const R = Math.max(W, H / SIN) * 0.75;
  key.shadow.camera.left = -R; key.shadow.camera.right = R;
  key.shadow.camera.top = R; key.shadow.camera.bottom = -R;
  key.shadow.camera.near = 500; key.shadow.camera.far = 3500;
  key.shadow.camera.updateProjectionMatrix();

  catcher.scale.set(W * 2, H / SIN * 2, 1);
  catcher.position.copy(center);

  pawns.forEach((p) => { toWorld(p.px, p.py + BASE_DOWN * tokenPx, p.group.position); });
}

function frame(now) {
  rafId = requestAnimationFrame(frame);
  tickTweens(now);
  idle(now);
  if (document.hidden || !canvas || canvas.clientWidth === 0) return;
  renderer.render(scene, camera);
}

/** The active player's ring breathes; nothing on the pawn body changes. */
function idle(now) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 200);
  pawns.forEach((p, i) => {
    if (p.effect) return;                          // an effect owns the ring right now
    const on = i === activeIdx;
    p.ring.visible = on;
    if (on) {
      p.ringMat.color.setHex(RING.active);
      p.ringMat.opacity = 0.65 + 0.35 * pulse;
      const s = tokenPx * 1.5 * (1 + 0.18 * pulse);
      p.ring.scale.set(s, s, tokenPx * 0.9);
    }
  });
}

/* =================== public API =================== */

/** Solid-colour pawn material. Never emissive: the player colour must stay put. */
function pawnMaterial(colorId) {
  return new THREE.MeshPhysicalMaterial({
    color: COLOURS[colorId] ?? COLOURS.red,
    roughness: 0.3, metalness: 0,
    clearcoat: 0.8, clearcoatRoughness: 0.2,
  });
}

export function setTokens(colorIds) {
  if (!scene) return;
  pawns.forEach((p) => { scene.remove(p.group); p.mesh.material.dispose(); p.ringMat.dispose(); });
  pawns = [];
  activeIdx = -1;
  colorIds.forEach((colorId, i) => {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(pawnGeo, pawnMaterial(colorId || 'red'));
    mesh.castShadow = true;
    const ringMat = new THREE.MeshBasicMaterial({ color: RING.active, transparent: true, opacity: 0.8, depthWrite: false });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.5;
    ring.visible = false;
    group.add(mesh, ring);
    group.name = `token${i}`;
    scene.add(group);
    pawns.push({ group, mesh, ring, ringMat, px: 0, py: 0, move: null, effect: null });
  });
  applyScale();
}

export function setTokenSize(px) {
  const next = Math.max(8, px || 22);
  if (next === tokenPx) return;
  tokenPx = next;
  applyScale();
}

function applyScale() {
  const h = tokenPx * PAWN_H;
  pawns.forEach((p) => {
    p.mesh.scale.set(h, h, h);
    p.ring.scale.set(tokenPx * 1.5, tokenPx * 1.5, tokenPx * 0.9);
    toWorld(p.px, p.py + BASE_DOWN * tokenPx, p.group.position);
  });
}

/**
 * Moves a pawn to a wrapper-relative pixel centre. duration 0 snaps; otherwise
 * it glides there, lifting by `hop` px at mid-flight. A move that arrives while
 * another is in progress takes over from the pawn's current spot.
 */
export function moveToken(idx, x, y, { duration = 0, hop = 0 } = {}) {
  const p = pawns[idx];
  if (!p) return Promise.resolve();
  p.px = x; p.py = y;
  if (p.move) { cancelTween(p.move.handle); p.move = null; }
  const target = toWorld(x, y + BASE_DOWN * tokenPx);
  if (duration <= 0) {
    p.group.position.copy(target);
    return Promise.resolve();
  }
  const from = p.group.position.clone();
  from.y = 0;
  const pr = tween(duration, (e, t) => {
    p.group.position.lerpVectors(from, target, e);
    p.group.position.y = Math.sin(Math.PI * t) * hop;
    const s = 1 + 0.08 * Math.sin(Math.PI * t);
    p.mesh.scale.set(tokenPx * PAWN_H / Math.sqrt(s), tokenPx * PAWN_H * s, tokenPx * PAWN_H / Math.sqrt(s));
  });
  p.move = pr;
  return pr.then(() => {
    if (p.move === pr) p.move = null;
    p.mesh.scale.setScalar(tokenPx * PAWN_H);
    if (p.px === x && p.py === y) p.group.position.copy(target);
  });
}

export function setActiveToken(idx) {
  activeIdx = idx;
}

/**
 * Feedback effects. The body colour is left alone; the ring under the pawn
 * carries the cue.
 *   jump        rolled a six â€” celebratory hop in place (600 ms)
 *   penalty     three sixes / captured â€” red ring flash + shake (1500 ms)
 *   snake-hit   red ring flash + shake (500 ms)
 *   ladder-hit  gold ring flash + bounce (500 ms)
 */
export function playEffect(idx, kind) {
  const p = pawns[idx];
  if (!p) return Promise.resolve();
  // Effects offset the mesh inside its group, so a simultaneous moveToken (which
  // drives the group) is never fought over â€” e.g. the capture fly-back.
  if (kind === 'jump') {
    return tween(600, (e, t) => {
      p.mesh.position.y = Math.sin(Math.PI * t) * tokenPx * 1.1;
    }, linear).then(() => { p.mesh.position.y = 0; });
  }
  const red = kind === 'penalty' || kind === 'snake-hit';
  const ms = kind === 'penalty' ? 1500 : 500;
  const cycles = kind === 'penalty' ? 3 : 2;
  p.effect = kind;
  p.ring.visible = true;
  p.ringMat.color.setHex(red ? RING.red : RING.gold);
  return tween(ms, (e, t) => {
    const k = Math.abs(Math.sin(t * Math.PI * cycles));
    p.ringMat.opacity = 0.25 + 0.75 * k;
    const s = 1 + 0.6 * k;
    p.ring.scale.set(tokenPx * 1.5 * s, tokenPx * 1.5 * s, tokenPx * 0.9);
    if (red) p.mesh.position.x = Math.sin(t * 70) * tokenPx * 0.12 * (1 - t);
    else p.mesh.position.y = k * tokenPx * 0.35;
  }, linear).then(() => {
    p.mesh.position.set(0, 0, 0);
    p.ring.scale.set(tokenPx * 1.5, tokenPx * 1.5, tokenPx * 0.9);
    p.effect = null;
  });
}

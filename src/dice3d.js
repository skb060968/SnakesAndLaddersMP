/**
 * Snakes & Ladders MP — 3D dice (three.js)
 *
 * A transparent WebGL canvas over the dice panel. The die drops in from above the top
 * of the panel spinning fast, lands, bounces on while its tumble is steered into a roll
 * along the line of travel, then tips over once more on the table and settles in the
 * centre with the rolled value on top. Purely visual: the value comes from the engine,
 * the motion is simple ballistics plus a scripted orientation, so it always lands on
 * the number it was told to.
 *
 *   mount(panelEl)          → boolean (false if WebGL failed; caller falls back to the CSS cube)
 *   throwDie(value, {onBounce}) → Promise<void>, resolves when the die has settled (THROW_MS)
 *   showDie(value)          show it at rest with `value` up
 *   hideDie()               hide it (CSS-cube roll, new game)
 *   THROW_MS                total animation length
 *
 * Look: traditional white plastic with black recessed pips and bevelled edges (all drawn
 * procedurally). Opposite faces sum to 7: +x 3, −x 4, +y 1, −y 6, +z 2, −z 5.
 *
 * Motion: ONE roll axis for the whole throw — the x axis, across the line of travel — so
 * the die goes face-over-face down the screen like a real thrown die. The starting
 * orientation is the target rotated backwards by the total spin, so the sequence ends
 * exactly on the result with no blending. (Only the four faces on the rolling belt can
 * come up; the result is always one of them by construction.)
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* The throw is three beats, timed by simple ballistics (heights in die-size units):
 *   flight  — drops in from above the top of the panel, spinning fast, lands 60 % of the way
 *   bounce  — kicks up (restitution E) and covers the next 30 %; in the air the free tumble
 *             is steered into a clean roll about the axis across the travel, phased so the
 *             result face comes round on the line of the roll
 *   roll    — the last 10 % on the table: tips over one edge, slowing, and settles with
 *             the result on top at the panel centre
 * The bounce's duration follows from the drop (T2 = 2·E·T1), so the arcs look right. */
const T1 = 0.55, E = 0.42, T2 = 2 * E * T1, T3 = 0.72;
export const THROW_MS = Math.round((T1 + T2 + T3) * 1000);
const DROP_H = 2.4;                          // release height, in die sizes
const G = 2 * DROP_H / (T1 * T1);            // gravity that brings it down in exactly T1
const FLIGHT_TURNS = 2.75;                   // full turns about the roll axis during the drop
const BOUNCE_TURNS = 1.0;                    // during the bounce (slower: energy lost on landing)
const FINAL_FLOP = Math.PI / 2;              // the last face-over-face tip on the table
const WOBBLE = 0.35;                         // rad of secondary wobble about the travel axis, dying out in flight

const ELEV = THREE.MathUtils.degToRad(58);   // camera elevation: top face reads clearly, two sides show depth
const SIN = Math.sin(ELEV);
const FACE_VALUES = [3, 4, 1, 6, 2, 5];      // BoxGeometry material order: +x −x +y −y +z −z
const FACE_NORMALS = [
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
];
const UP = new THREE.Vector3(0, 1, 0);

let panel = null, canvas = null, renderer = null, scene = null, camera = null, key = null, catcher = null;
let die = null, dieSize = 60;
let W = 1, H = 1;
let rafId = 0;
let anim = null;                              // { start, from, to, q0, qTarget, spin, resolve }
let resizeObserver = null;
let panelCX = 0, panelCY = 0;                 // panel centre in canvas pixels (the canvas bleeds past the panel)
let restQ = new THREE.Quaternion();           // orientation of the die at rest (last value up)

/* =================== textures =================== */
/* Pip layout on a 3×3 grid (column, row), 0..2. */
const PIPS = {
  1: [[1, 1]],
  2: [[0, 0], [2, 2]],
  3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [2, 0], [0, 2], [2, 2]],
  5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
  6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
};

/**
 * Colour map for one face: white plastic with black recessed pips. Each pip is drawn
 * as a dark disc with a lighter inner gradient and a faint highlight on its lower rim,
 * which reads as a drilled hollow under the key light.
 */
function faceTexture(value) {
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f4f2ee'; ctx.fillRect(0, 0, S, S);
  const r = S * 0.085, step = S * 0.27, off = S / 2 - step;
  (PIPS[value] || PIPS[1]).forEach(([cx, cy]) => {
    const x = off + cx * step, y = off + cy * step;
    // the hollow
    const g = ctx.createRadialGradient(x - r * 0.25, y - r * 0.3, r * 0.1, x, y, r);
    g.addColorStop(0, '#2a2a2e'); g.addColorStop(0.7, '#101012'); g.addColorStop(1, '#050506');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    // lit lower-right rim of the recess
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = r * 0.14;
    ctx.beginPath(); ctx.arc(x, y, r * 0.93, Math.PI * 0.15, Math.PI * 0.75); ctx.stroke();
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Roughness map: the pips are matte (drilled and painted), the faces glossy. */
function faceRoughness(value) {
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2e2e2e'; ctx.fillRect(0, 0, S, S);             // ~0.18 roughness on the plastic
  const r = S * 0.085, step = S * 0.27, off = S / 2 - step;
  ctx.fillStyle = '#b0b0b0';                                          // ~0.7 in the pips
  (PIPS[value] || PIPS[1]).forEach(([cx, cy]) => {
    ctx.beginPath(); ctx.arc(off + cx * step, off + cy * step, r, 0, Math.PI * 2); ctx.fill();
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/* =================== coordinates =================== */
/** Panel pixel → world point on the "table" (same tilted-ortho trick as tokens3d). */
function toWorld(px, py, out = new THREE.Vector3()) {
  return out.set(px, 0, py / SIN);
}

/* =================== mount / resize / loop =================== */
export function mount(panelEl) {
  if (renderer) {
    if (!canvas.isConnected) panelEl.appendChild(canvas);
    return true;
  }
  panel = panelEl;
  canvas = document.createElement('canvas');
  canvas.className = 'dice3d-layer';
  canvas.setAttribute('aria-hidden', 'true');
  panel.appendChild(canvas);
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (err) {
    console.error('3D dice unavailable:', err);
    canvas.remove(); canvas = null; renderer = null;
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();

  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 4000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a6a48, 0.7));
  key = new THREE.DirectionalLight(0xfff3e0, 2.0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0005; key.shadow.normalBias = 0.5;
  scene.add(key, key.target);

  catcher = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.35 }));
  catcher.rotation.x = -Math.PI / 2; catcher.receiveShadow = true;
  scene.add(catcher);

  // Classic white casino-style plastic: glossy faces, matte pips, generous bevelled edges
  // (the rounded-box radius is 13 % of the side with 6 segments so the bevel catches light).
  const mats = FACE_VALUES.map((v) => new THREE.MeshPhysicalMaterial({
    map: faceTexture(v), roughnessMap: faceRoughness(v), roughness: 1, metalness: 0,
    clearcoat: 0.9, clearcoatRoughness: 0.12, specularIntensity: 0.8,
  }));
  die = new THREE.Mesh(new RoundedBoxGeometry(1, 1, 1, 6, 0.13), mats);
  die.castShadow = true;
  die.visible = false;
  scene.add(die);

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => resize());
    resizeObserver.observe(panel);
  }
  resize();
  if (!rafId) rafId = requestAnimationFrame(frame);
  return true;
}

function resize() {
  if (!renderer || !canvas) return;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (cw < 2 || ch < 2) return;
  W = cw; H = ch;
  renderer.setSize(W, H, false);
  // The canvas is larger than the panel (CSS bleed); the die rests at the PANEL's centre.
  panelCX = panel.clientWidth / 2 - canvas.offsetLeft;
  panelCY = panel.clientHeight / 2 - canvas.offsetTop;
  dieSize = Math.min(panel.clientHeight * 0.7, 72);
  die.scale.setScalar(dieSize);

  const center = new THREE.Vector3(W / 2, 0, H / (2 * SIN));
  camera.left = -W / 2; camera.right = W / 2; camera.top = H / 2; camera.bottom = -H / 2;
  camera.position.copy(center).add(new THREE.Vector3(0, Math.sin(ELEV), Math.cos(ELEV)).multiplyScalar(1500));
  camera.lookAt(center);
  camera.updateProjectionMatrix();

  key.position.copy(center).add(new THREE.Vector3(-0.5, 1, 0.4).normalize().multiplyScalar(1000));
  key.target.position.copy(center);
  const R = Math.max(W, H / SIN) * 0.7;
  key.shadow.camera.left = -R; key.shadow.camera.right = R; key.shadow.camera.top = R; key.shadow.camera.bottom = -R;
  key.shadow.camera.near = 200; key.shadow.camera.far = 1800;
  key.shadow.camera.updateProjectionMatrix();

  catcher.scale.set(W * 3, H / SIN * 3, 1);
  catcher.position.copy(center);

  if (!anim && die.visible) restPosition(die.position);
}

/** Where the die sits when settled: panel centre, resting on the table. */
function restPosition(out) {
  toWorld(panelCX, panelCY, out);
  out.y = dieSize / 2;
  return out;
}

function frame(now) {
  rafId = requestAnimationFrame(frame);
  if (anim) tick(now);
  if (document.hidden || !canvas || canvas.clientWidth === 0) return;
  renderer.render(scene, camera);
}

/* =================== the throw =================== */
/**
 * Orientation that puts face `value` on top, square to the travel. Two of the four yaws
 * put the result on the rolling belt (faces flipping about x pass through ±y and ±z), so
 * the yaw is a random one of those, plus a mirror choice for the front face.
 */
function targetQuaternion(value) {
  const n = FACE_NORMALS[FACE_VALUES.indexOf(value)] || FACE_NORMALS[2];
  const q = new THREE.Quaternion().setFromUnitVectors(n, UP);
  // setFromUnitVectors gives the shortest rotation, which for ±x faces leaves them tilted
  // about z; a yaw of 0 or π keeps the belt (the faces that flip about x) aligned to travel.
  const yaw = new THREE.Quaternion().setFromAxisAngle(UP, Math.random() < 0.5 ? 0 : Math.PI);
  return yaw.multiply(q);
}

/** Show the die at rest in the panel centre with `value` up (no animation). */
export function showDie(value = 1) {
  if (!renderer || !die) return;
  if (anim) finish();
  restQ = targetQuaternion(value);
  die.quaternion.copy(restQ);
  restPosition(die.position);
  die.visible = true;
}

const X_AXIS = new THREE.Vector3(1, 0, 0);
const rotX = (angle) => new THREE.Quaternion().setFromAxisAngle(X_AXIS, angle);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * Throw the die so it comes to rest at the panel centre with `value` on top.
 * @param {number} value 1–6
 * @param {{onBounce?: (strength:number) => void}} [opts] called at each table contact
 * @returns {Promise<void>} resolves when the die has settled
 */
export function throwDie(value, opts = {}) {
  if (!renderer || !die) return Promise.resolve();
  if (anim) finish();
  die.visible = true;
  const to = restPosition(new THREE.Vector3());
  // Travel is straight down the screen (+z) from above the top of the canvas to the centre,
  // with a little sideways drift during the flight that is gone by the first landing.
  const startPy = -dieSize;
  const drift = (Math.random() - 0.5) * panel.clientWidth * 0.3;
  const D = panelCY - startPy;
  const qTarget = targetQuaternion(value);
  // Everything rolls about x. Working backwards from the result: the die is flat (a face
  // down) at the 2nd landing, one quarter-turn short of the target; the bounce and the
  // flight are whole turns before that, so they end on the same flat orientation.
  const q2 = rotX(-FINAL_FLOP).multiply(qTarget);              // at the 2nd landing
  const wobbleSign = Math.random() < 0.5 ? -1 : 1;
  return new Promise((resolve) => {
    anim = {
      start: performance.now(), last: performance.now(), to, startPy, drift, D,
      qTarget, q2, wobbleSign, resolve, onBounce: opts.onBounce, bounced: 0,
    };
    anim.timer = setTimeout(() => finish(), THROW_MS + 80);
  });
}

function finish() {
  if (!anim) return;
  const a = anim; anim = null;
  clearTimeout(a.timer);
  die.position.copy(a.to);
  die.quaternion.copy(a.qTarget);
  restQ = a.qTarget;
  a.resolve();
}

function tick(now) {
  const a = anim;
  const tSec = Math.min(T1 + T2 + T3, (now - a.start) / 1000);
  const dt = Math.min(0.05, (now - a.last) / 1000); a.last = now;
  const s = dieSize, rest = s / 2;
  let py, px = panelCX, height, q;

  const TWO_PI = 2 * Math.PI;
  if (tSec < T1) {
    /* ---- flight: constant horizontal speed, free fall, fast roll about x ---- */
    const k = tSec / T1;
    py = a.startPy + a.D * 0.6 * k;
    px = panelCX + a.drift * (1 - k);
    height = (DROP_H - 0.5 * G * tSec * tSec) * s;
    // whole turns that end on q2's orientation at the moment of landing
    const roll = -(FLIGHT_TURNS + BOUNCE_TURNS) * TWO_PI * (1 - k);
    q = rotX(roll).multiply(a.q2);
    // a little wobble about the travel axis (z) that dies out before landing
    const wob = a.wobbleSign * WOBBLE * (1 - k) * Math.sin(k * Math.PI * 2.5);
    q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), wob).multiply(q);
  } else if (tSec < T1 + T2) {
    /* ---- bounce: kicks up with restitution E; same axis, fewer turns ---- */
    if (a.bounced < 1) { a.bounced = 1; a.onBounce?.(1); }
    const u = tSec - T1, k = u / T2;
    py = a.startPy + a.D * (0.6 + 0.3 * k);
    const vUp = E * G * T1;
    height = Math.max(0, vUp * u - 0.5 * G * u * u) * s;
    const roll = -BOUNCE_TURNS * TWO_PI * (1 - k);
    q = rotX(roll).multiply(a.q2);
  } else {
    /* ---- roll: the last 10 % on the table, one face-over-face tip, slowing to rest ---- */
    if (a.bounced < 2) { a.bounced = 2; a.onBounce?.(0.55); }
    const u = tSec - T1 - T2, k = Math.min(1, u / T3);
    const e = easeOutCubic(k);
    py = a.startPy + a.D * (0.9 + 0.1 * e);
    const theta = FINAL_FLOP * e;
    // a square tipping over an edge: its centre rides up to s/√2 at 45° and back down
    height = (Math.abs(Math.cos(theta)) + Math.abs(Math.sin(theta))) * rest - rest;
    if (a.bounced < 3 && theta > FINAL_FLOP * 0.92) { a.bounced = 3; a.onBounce?.(0.3); }
    q = rotX(theta - FINAL_FLOP).multiply(a.qTarget);
    if (k > 0.85) {                              // faint rock as it comes to rest
      const r = (k - 0.85) / 0.15;
      q = rotX(Math.sin(r * Math.PI * 2) * (1 - r) * 0.05).multiply(q);
    }
  }

  toWorld(px, py, die.position);
  die.position.y = rest + Math.max(0, height);
  die.quaternion.copy(q);
  if (tSec >= T1 + T2 + T3) finish();
}

export function hideDie() {
  if (anim) finish();
  if (die) die.visible = false;
}

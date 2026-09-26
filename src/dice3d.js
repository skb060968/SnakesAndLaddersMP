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
 * Faces are the same die-1…6 PNGs the CSS cube uses, downscaled to 256² for the GPU.
 * Opposite faces sum to 7: +x 3, −x 4, +y 1, −y 6, +z 2, −z 5.
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
const ROLL_TURNS_AIR = 1.25;                 // full turns rolled during the bounce
const FINAL_FLOP = Math.PI / 2;              // the last face-over-face tip on the table

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
function faceTexture(value) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f7f3ea'; ctx.fillRect(0, 0, 256, 256);   // placeholder until the PNG lands
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const img = new Image();
  img.onload = () => { ctx.drawImage(img, 0, 0, 256, 256); tex.needsUpdate = true; };
  img.src = `/images/die-${value}.png`;
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

  const mats = FACE_VALUES.map((v) => new THREE.MeshPhysicalMaterial({
    map: faceTexture(v), roughness: 0.28, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.2,
  }));
  die = new THREE.Mesh(new RoundedBoxGeometry(1, 1, 1, 4, 0.09), mats);
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
 * Orientation that puts face `value` on top. The yaw is a random quarter-turn so the
 * faces stay square to the direction of travel: the die rolls face-over-face along
 * the line of the throw and finishes exactly on the result.
 */
function targetQuaternion(value) {
  const n = FACE_NORMALS[FACE_VALUES.indexOf(value)] || FACE_NORMALS[2];
  const q = new THREE.Quaternion().setFromUnitVectors(n, UP);
  const yaw = new THREE.Quaternion().setFromAxisAngle(UP, Math.floor(Math.random() * 4) * Math.PI / 2);
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
  const q2 = rotX(-FINAL_FLOP).multiply(qTarget);              // orientation at the 2nd landing (flat)
  const spinAxis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
  return new Promise((resolve) => {
    anim = {
      start: performance.now(), last: performance.now(), to, startPy, drift, D,
      qFree: new THREE.Quaternion().random(), spinAxis, spinRate: 20 + Math.random() * 6,   // rad/s
      qTarget, q2, resolve, onBounce: opts.onBounce, bounced: 0,
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

  if (tSec < T1) {
    /* ---- flight: constant horizontal speed, free fall, fast free tumble ---- */
    const k = tSec / T1;
    py = a.startPy + a.D * 0.6 * k;
    px = panelCX + a.drift * (1 - k);
    height = (DROP_H - 0.5 * G * tSec * tSec) * s;
    a.qFree.premultiply(new THREE.Quaternion().setFromAxisAngle(a.spinAxis, a.spinRate * dt)).normalize();
    q = a.qFree;
  } else if (tSec < T1 + T2) {
    /* ---- bounce: kicks up with restitution E; the tumble is steered into a roll ---- */
    if (a.bounced < 1) { a.bounced = 1; a.onBounce?.(1); }
    const u = tSec - T1, k = u / T2;
    py = a.startPy + a.D * (0.6 + 0.3 * k);
    const vUp = E * G * T1;
    height = Math.max(0, vUp * u - 0.5 * G * u * u) * s;
    // free tumble continues, slowed by the impact
    a.qFree.premultiply(new THREE.Quaternion().setFromAxisAngle(a.spinAxis, a.spinRate * 0.45 * dt)).normalize();
    // the clean roll it is being steered onto: about the axis across the travel, ending at q2
    const rollAngle = ROLL_TURNS_AIR * 2 * Math.PI;
    const qRoll = rotX(rollAngle * (k - 1)).multiply(a.q2);
    q = a.qFree.clone().slerp(qRoll, smooth(k / 0.65));   // fully aligned by 65 % of the bounce
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

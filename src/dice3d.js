/**
 * Snakes & Ladders MP — 3D dice (three.js)
 *
 * A transparent WebGL canvas over the dice panel. The die tumbles in from the right
 * edge of the control panel, bounces twice and settles in the centre with the rolled
 * value on top. Purely visual: the value comes from the engine, the tumble is scripted
 * (no physics), so it always lands on the number it was told to.
 *
 *   mount(panelEl)          → boolean (false if WebGL failed; caller falls back to the CSS cube)
 *   throwDie(value)         → Promise<void>, resolves when the die has settled (THROW_MS)
 *   hideDie()               hide it (CSS-cube roll, new game)
 *   THROW_MS                total animation length
 *
 * Faces are the same die-1…6 PNGs the CSS cube uses, downscaled to 256² for the GPU.
 * Opposite faces sum to 7: +x 3, −x 4, +y 1, −y 6, +z 2, −z 5.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const THROW_MS = 1800;

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
/** Orientation that puts face `value` on top, with a random yaw about the vertical. */
function targetQuaternion(value) {
  const n = FACE_NORMALS[FACE_VALUES.indexOf(value)] || FACE_NORMALS[2];
  const q = new THREE.Quaternion().setFromUnitVectors(n, UP);
  const yaw = new THREE.Quaternion().setFromAxisAngle(UP, (Math.random() - 0.5) * 0.9);
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

/**
 * The throw, in four beats over THROW_MS:
 *   0.00–0.30  flies in from off the right edge in a high arc, tumbling fast
 *   0.30–0.55  first bounce: lands short of centre, kicks up, keeps rolling toward it
 *   0.55–0.78  second, lower bounce; the tumble is now mostly a roll about one axis
 *   0.78–1.00  skids the last bit, overshoots the centre a touch, rocks and settles
 * The orientation is a free tumble that decays, blended into the exact target over the
 * last 45 % so the value is always right; a final tiny rock sells the settle.
 */
export function throwDie(value) {
  if (!renderer || !die) return Promise.resolve();
  if (anim) finish();
  die.visible = true;
  const to = restPosition(new THREE.Vector3());
  const from = toWorld(panelCX + panel.clientWidth * 0.5 + dieSize * 2.2, panelCY + dieSize * 0.4);
  // Waypoints along the run-in: first landing right of centre, second just past centre.
  const p1 = toWorld(panelCX + panel.clientWidth * 0.22, panelCY - dieSize * 0.15);
  const p2 = toWorld(panelCX - dieSize * 0.35, panelCY + dieSize * 0.1);
  const q0 = new THREE.Quaternion().random();
  // Tumble axis mostly across the travel (x), so the die rolls end over end, plus a wobble.
  const spin = new THREE.Vector3(1, 0.35 * (Math.random() - 0.5), 0.9 + Math.random() * 0.4).normalize()
    .multiplyScalar(18 + Math.random() * 6);              // rad/s at release
  return new Promise((resolve) => {
    anim = {
      start: performance.now(), last: performance.now(), from, p1, p2, to,
      q0, q: q0.clone(), qTarget: targetQuaternion(value), spin, resolve,
      rockAxis: new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize(),
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

const easeOut = (t) => 1 - Math.pow(1 - t, 2);
const seg = (t, a, b) => Math.min(1, Math.max(0, (t - a) / (b - a)));

function tick(now) {
  const a = anim;
  const t = Math.min(1, (now - a.start) / THROW_MS);
  const dt = Math.min(0.05, (now - a.last) / 1000); a.last = now;
  const rest = dieSize / 2;
  const pos = die.position;
  let lift = 0;
  if (t < 0.30) {                               // flight in
    const k = seg(t, 0, 0.30);
    pos.lerpVectors(a.from, a.p1, k);
    lift = Math.sin(k * Math.PI) * dieSize * 1.9 + (1 - k) * dieSize * 0.6;
  } else if (t < 0.55) {                        // bounce 1
    const k = seg(t, 0.30, 0.55);
    pos.lerpVectors(a.p1, a.p2, easeOut(k));
    lift = Math.sin(k * Math.PI) * dieSize * 0.7;
  } else if (t < 0.78) {                        // bounce 2, rolling on
    const k = seg(t, 0.55, 0.78);
    const over = a.to.clone().addScaledVector(a.to.clone().sub(a.p2).normalize(), dieSize * 0.18); // slight overshoot
    pos.lerpVectors(a.p2, over, easeOut(k));
    lift = Math.sin(k * Math.PI) * dieSize * 0.28;
  } else {                                      // skid back to centre and settle
    const k = seg(t, 0.78, 1);
    const over = a.to.clone().addScaledVector(a.to.clone().sub(a.p2).normalize(), dieSize * 0.18);
    pos.lerpVectors(over, a.to, easeOut(k));
    lift = Math.max(0, Math.sin(k * Math.PI * 2) * (1 - k)) * dieSize * 0.05;
  }
  pos.y = rest + lift;

  // Free tumble, decaying; each landing knocks the spin down hard (energy lost to the table).
  const decay = t < 0.30 ? 1 : t < 0.55 ? 0.55 : t < 0.78 ? 0.28 : 0.1;
  const w = a.spin.clone().multiplyScalar(decay * (1 - t * 0.5));
  const ang = w.length() * dt;
  if (ang > 0) a.q.premultiply(new THREE.Quaternion().setFromAxisAngle(w.normalize(), ang)).normalize();
  if (t > 0.55) {
    const k = seg(t, 0.55, 1);
    die.quaternion.slerpQuaternions(a.q, a.qTarget, k * k * (3 - 2 * k));
    if (t > 0.78) {                             // rock on the landing edge, dying out
      const r = seg(t, 0.78, 1);
      const rock = Math.sin(r * Math.PI * 3) * (1 - r) * 0.16;
      die.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(a.rockAxis, rock));
    }
  } else {
    die.quaternion.copy(a.q);
  }
  if (t >= 1) finish();
}

export function hideDie() {
  if (anim) finish();
  if (die) die.visible = false;
}

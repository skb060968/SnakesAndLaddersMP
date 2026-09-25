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

export const THROW_MS = 1500;

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
  dieSize = Math.min(H * 0.62, 72);
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
  toWorld(W / 2, H / 2, out);
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

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

export function throwDie(value) {
  if (!renderer || !die) return Promise.resolve();
  if (anim) { anim.resolve(); anim = null; }
  die.visible = true;
  const from = toWorld(W / 2 + W * 0.55 + dieSize, H * 0.42);
  const to = restPosition(new THREE.Vector3());
  const q0 = new THREE.Quaternion().random();
  const spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize()
    .multiplyScalar(14 + Math.random() * 6);              // rad/s at release
  return new Promise((resolve) => {
    anim = { start: performance.now(), from, to, q0, qTarget: targetQuaternion(value), spin, resolve, q: q0.clone(), last: performance.now() };
    anim.timer = setTimeout(() => finish(), THROW_MS + 80);
  });
}

function finish() {
  if (!anim) return;
  const a = anim; anim = null;
  clearTimeout(a.timer);
  die.position.copy(a.to);
  die.quaternion.copy(a.qTarget);
  a.resolve();
}

function tick(now) {
  const a = anim;
  const t = Math.min(1, (now - a.start) / THROW_MS);
  const dt = Math.min(0.05, (now - a.last) / 1000); a.last = now;
  // Travel: quick at first, braking hard into the centre.
  const e = easeOutCubic(t);
  die.position.lerpVectors(a.from, a.to, e);
  // Height: a throw arc, then two shrinking bounces, then rest on the table.
  const rest = dieSize / 2;
  let lift;
  if (t < 0.45) lift = Math.sin((t / 0.45) * Math.PI) * dieSize * 1.6;
  else if (t < 0.72) lift = Math.sin(((t - 0.45) / 0.27) * Math.PI) * dieSize * 0.55;
  else if (t < 0.88) lift = Math.sin(((t - 0.72) / 0.16) * Math.PI) * dieSize * 0.18;
  else lift = 0;
  die.position.y = rest + lift;
  // Spin: free tumble that slows, blending into the target orientation over the last 40%.
  const w = a.spin.clone().multiplyScalar(Math.pow(1 - t, 1.6));
  const ang = w.length() * dt;
  if (ang > 0) {
    const dq = new THREE.Quaternion().setFromAxisAngle(w.normalize(), ang);
    a.q.premultiply(dq).normalize();
  }
  if (t > 0.6) {
    const k = (t - 0.6) / 0.4;
    die.quaternion.slerpQuaternions(a.q, a.qTarget, k * k * (3 - 2 * k));
  } else {
    die.quaternion.copy(a.q);
  }
  if (t >= 1) finish();
}

export function hideDie() {
  if (anim) finish();
  if (die) die.visible = false;
}

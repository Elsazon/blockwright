/* Blockwright — main thread: scene, picking, tools, panels.
   The voxel data lives in the worker; this file draws it and sends edits. */
import { BLOCKS, CATEGORIES, BY_ID, colourOf } from './blocks.js';
import * as Projects from './projects.js';

const $ = s => document.querySelector(s);
const AIR = 'minecraft:air';

/* ---------------------------------------------------------------- worker */
/* A classic worker, not a module one: module workers fail silently on older
   iPadOS Safari and inside sandboxed frames, which looks like an app where
   no button does anything. */
let worker = null, workerDead = false;
let seq = 0;
const pending = new Map();

function fatal(msg, detail) {
  workerDead = true;
  for (const h of pending.values()) h.reject && h.reject(new Error(msg));
  pending.clear();
  const b = document.querySelector('#boot');
  if (b) {
    b.hidden = false;
    b.innerHTML = '<div style="max-width:420px;padding:0 24px;text-align:left">' +
      '<p style="color:var(--danger);margin-bottom:10px">Something went wrong</p>' +
      '<p style="font:14px/1.6 Barlow,sans-serif;color:var(--text);text-transform:none;letter-spacing:0;font-weight:400">' +
      msg + '</p>' +
      (detail ? '<p class="mono" style="font-size:11px;color:var(--muted);text-transform:none;letter-spacing:0;' +
        'margin-top:10px;word-break:break-all;font-weight:400">' + String(detail).slice(0, 300) + '</p>' : '') +
      '<p style="font:13px/1.6 Barlow,sans-serif;color:var(--muted);text-transform:none;letter-spacing:0;' +
      'margin-top:14px;font-weight:400">Reload the page to try again. If it keeps happening, send me this message.</p>' +
      '</div>';
  }
}

function startWorker() {
  try {
    worker = new Worker('js/worker.bundle.js');
  } catch (err) {
    fatal('The app could not start its engine, so nothing on screen will respond.', err.message);
    return false;
  }
  worker.onerror = (e) => {
    fatal('The engine stopped with an error.', (e && e.message) || 'unknown');
  };
  worker.onmessage = (e) => {
    const m = e.data, h = pending.get(m.id);
    if (!h) return;
    if (h.stream) { h.onPart(m); if (m.done) { pending.delete(m.id); h.resolve(); } return; }
    pending.delete(m.id);
    m.ok === false ? h.reject(new Error(m.error || 'worker failed')) : h.resolve(m);
  };
  return true;
}

function call(msg, transfer) {
  if (workerDead) return Promise.reject(new Error('engine not running'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer || []);
  });
}
function stream(msg, onPart) {
  if (workerDead) return Promise.reject(new Error('engine not running'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, stream: true, onPart });
    worker.postMessage({ ...msg, id });
  });
}

/* ---------------------------------------------------------------- state */
let W = 0, H = 0, L = 0, CS = 32, nChunks = [0, 0, 0];
let palette = [AIR];
let projectName = 'Untitled';
let projectId = null;
let selectedBlock = 'minecraft:stone';
let tool = 'orbit';
let yMin = 0, yMax = 0;
let dirty = false;
const undoStack = [], redoStack = [];
let sel = { a: null, b: null };

/* ---------------------------------------------------------------- three */
let renderer, scene, camera, pickTarget, needsRender = true;
const chunkMeshes = new Map();     // key -> {mesh, pickMesh, blk, cell, dir}
let pickScene, selBox = null, gridHelper = null;
const chunkByOrd = new Map();       // ordinal -> chunk key
const freeOrds = [];
let nextOrd = 1;                    // 0 means "nothing"
function takeOrd() { return freeOrds.length ? freeOrds.pop() : nextOrd++; }
const MATS = {};

function initThree() {
  const canvas = $('#gl');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  pickTarget = new THREE.WebGLRenderTarget(1, 1);
  scene = new THREE.Scene();
  pickScene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, 1, 0.1, 6000);

  MATS.solid = new THREE.ShaderMaterial({
    uniforms: { uYMin: { value: 0 }, uYMax: { value: 1e9 }, uFog: { value: new THREE.Color(0x12100d) },
                uNear: { value: 100 }, uFar: { value: 600 } },
    vertexShader: `
      attribute vec3 aColor;
      uniform float uYMin, uYMax;
      varying vec3 vColor; varying float vDepth;
      void main(){
        if (position.y < uYMin - 0.001 || position.y > uYMax + 1.001) {
          gl_Position = vec4(2.0,2.0,2.0,1.0); return;
        }
        vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(position,1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uFog; uniform float uNear, uFar;
      varying vec3 vColor; varying float vDepth;
      void main(){
        float f = clamp((vDepth-uNear)/(uFar-uNear), 0.0, 1.0);
        gl_FragColor = vec4(mix(vColor, uFog, f*0.7), 1.0);
      }`,
    side: THREE.DoubleSide
  });
  MATS.pickChunk = new THREE.ShaderMaterial({
    uniforms: { uYMin: { value: 0 }, uYMax: { value: 1e9 } },
    vertexShader: `
      attribute vec3 aChunk;
      uniform float uYMin, uYMax;
      varying vec3 vC;
      void main(){
        if (position.y < uYMin - 0.001 || position.y > uYMax + 1.001) {
          gl_Position = vec4(2.0,2.0,2.0,1.0); return;
        }
        vC = aChunk / 255.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
      }`,
    fragmentShader: `varying vec3 vC; void main(){ gl_FragColor = vec4(vC, 1.0); }`,
    side: THREE.DoubleSide
  });
  MATS.pick = new THREE.ShaderMaterial({
    uniforms: { uYMin: { value: 0 }, uYMax: { value: 1e9 } },
    vertexShader: `
      attribute vec3 aId;
      uniform float uYMin, uYMax;
      varying vec3 vId;
      void main(){
        if (position.y < uYMin - 0.001 || position.y > uYMax + 1.001) {
          gl_Position = vec4(2.0,2.0,2.0,1.0); return;
        }
        vId = aId / 255.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
      }`,
    fragmentShader: `varying vec3 vId; void main(){ gl_FragColor = vec4(vId, 1.0); }`,
    side: THREE.DoubleSide
  });

  const bg = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0x2a2520, wireframe: true, transparent: true, opacity: 0.35 }));
  bg.name = 'bounds'; scene.add(bg);

  selBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ color: 0x4fb8ce }));
  selBox.visible = false; scene.add(selBox);

  window.addEventListener('resize', resize);
  initControls(canvas);
  tick();
}

function resize() {
  const s = $('#stage');
  if (!s.clientWidth || !s.clientHeight) return;
  renderer.setSize(s.clientWidth, s.clientHeight, false);
  camera.aspect = s.clientWidth / s.clientHeight;
  camera.updateProjectionMatrix();
  needsRender = true;
}

/* ---------------------------------------------------------------- camera */
const cam = { theta: -0.75, phi: 1.05, r: 120, tx: 0, ty: 0, tz: 0 };
function resetView() {
  cam.theta = -0.75; cam.phi = 1.05;
  cam.r = Math.max(W, L, H) * 1.5 + 12;
  cam.tx = W / 2; cam.ty = H * 0.35; cam.tz = L / 2;
  applyCam();
}
function applyCam() {
  const sp = Math.sin(cam.phi), cp = Math.cos(cam.phi);
  camera.position.set(cam.tx + cam.r * sp * Math.sin(cam.theta), cam.ty + cam.r * cp, cam.tz + cam.r * sp * Math.cos(cam.theta));
  camera.lookAt(cam.tx, cam.ty, cam.tz);
  MATS.solid.uniforms.uNear.value = cam.r * 0.6;
  MATS.solid.uniforms.uFar.value = cam.r * 2.6;
  needsRender = true;
}
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

function initControls(el) {
  const ptrs = {}; let last = null, pinch = 0, downT = 0, downP = null, moved = 0;
  const pts = () => Object.values(ptrs);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const f = new THREE.Vector3(), rr = new THREE.Vector3(), uu = new THREE.Vector3();
  function pan(dx, dy) {
    const k = cam.r * 0.0022;
    camera.getWorldDirection(f);
    rr.crossVectors(f, camera.up).normalize();
    uu.crossVectors(rr, f).normalize();
    cam.tx += (-rr.x * dx + uu.x * dy) * k;
    cam.ty += (-rr.y * dx + uu.y * dy) * k;
    cam.tz += (-rr.z * dx + uu.z * dy) * k;
  }
  el.addEventListener('pointerdown', e => {
    el.setPointerCapture(e.pointerId);
    ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    const n = pts().length;
    if (n === 1) { last = { x: e.clientX, y: e.clientY }; downT = Date.now(); downP = { x: e.clientX, y: e.clientY }; moved = 0; }
    if (n === 2) { const p = pts(); pinch = dist(p[0], p[1]); last = mid(p[0], p[1]); }
  });
  el.addEventListener('pointermove', e => {
    if (!ptrs[e.pointerId]) return;
    ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    const p = pts();
    if (p.length === 1) {
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      last = { x: e.clientX, y: e.clientY };
      if (e.shiftKey) pan(dx, dy);
      else { cam.theta -= dx * 0.006; cam.phi = clamp(cam.phi - dy * 0.006, 0.05, Math.PI - 0.05); }
      applyCam();
    } else if (p.length >= 2) {
      const d = dist(p[0], p[1]), m = mid(p[0], p[1]);
      if (pinch > 0) cam.r = clamp(cam.r * (pinch / d), 4, 4000);
      pan(m.x - last.x, m.y - last.y);
      pinch = d; last = m; moved += 99; applyCam();
    }
  });
  const up = e => {
    const one = pts().length === 1;
    delete ptrs[e.pointerId];
    if (one && moved < 9 && Date.now() - downT < 450 && downP) onTap(downP.x, downP.y);
    const p = pts(); if (p.length === 1) last = { x: p[0].x, y: p[0].y };
    pinch = 0;
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('wheel', e => {
    e.preventDefault();
    cam.r = clamp(cam.r * (1 + Math.sign(e.deltaY) * 0.12), 4, 4000);
    applyCam();
  }, { passive: false });
}

/* ---------------------------------------------------------------- chunks */
function clearChunks() {
  for (const c of chunkMeshes.values()) {
    scene.remove(c.mesh); pickScene.remove(c.pickMesh);
    c.mesh.geometry.dispose(); c.pickMesh.geometry.dispose();
  }
  chunkMeshes.clear(); chunkByOrd.clear(); freeOrds.length = 0; nextOrd = 1;
}
function applyChunk(c) {
  const key = `${c.cx},${c.cy},${c.cz}`;
  const old = chunkMeshes.get(key);
  let ord = old ? old.ord : 0;
  if (old) {
    scene.remove(old.mesh); pickScene.remove(old.pickMesh);
    old.mesh.geometry.dispose(); old.pickMesh.geometry.dispose();
    chunkMeshes.delete(key);
  }
  if (!c.quads) {
    if (ord) { chunkByOrd.delete(ord); freeOrds.push(ord); }
    needsRender = true; return;
  }
  if (!ord) ord = takeOrd();
  chunkByOrd.set(ord, key);
  const n = c.quads;
  const idxArr = new Uint32Array(n * 6);
  const ids = new Uint8Array(n * 4 * 3);
  const ords = new Uint8Array(n * 4 * 3);
  const o0 = ord & 255, o1 = (ord >> 8) & 255, o2 = (ord >> 16) & 255;
  for (let q = 0; q < n; q++) {
    const b = q * 4;
    idxArr[q * 6] = b; idxArr[q * 6 + 1] = b + 1; idxArr[q * 6 + 2] = b + 2;
    idxArr[q * 6 + 3] = b; idxArr[q * 6 + 4] = b + 2; idxArr[q * 6 + 5] = b + 3;
    const a0 = q & 255, a1 = (q >> 8) & 255, a2 = (q >> 16) & 255;
    for (let k = 0; k < 4; k++) {
      const o = (b + k) * 3;
      ids[o] = a0; ids[o + 1] = a1; ids[o + 2] = a2;
      ords[o] = o0; ords[o + 1] = o1; ords[o + 2] = o2;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Int16BufferAttribute(c.pos, 3));
  geo.setAttribute('aColor', new THREE.Uint8BufferAttribute(c.col, 3, true));
  geo.setIndex(new THREE.BufferAttribute(idxArr, 1));
  geo.computeBoundingSphere();

  const pgeo = new THREE.BufferGeometry();
  pgeo.setAttribute('position', new THREE.Int16BufferAttribute(c.pos, 3));
  pgeo.setAttribute('aId', new THREE.Uint8BufferAttribute(ids, 3, false));
  pgeo.setAttribute('aChunk', new THREE.Uint8BufferAttribute(ords, 3, false));
  pgeo.setIndex(new THREE.BufferAttribute(idxArr, 1));
  pgeo.boundingSphere = geo.boundingSphere;

  const mesh = new THREE.Mesh(geo, MATS.solid);
  const pickMesh = new THREE.Mesh(pgeo, MATS.pick);
  mesh.userData.key = key; pickMesh.userData.key = key;
  scene.add(mesh); pickScene.add(pickMesh);
  chunkMeshes.set(key, { mesh, pickMesh, blk: c.blk, cell: c.cell, dir: c.dir, ord });
  needsRender = true;
}

/* ---------------------------------------------------------------- picking */
/* Two readbacks, whatever the model size: pass one says which chunk was hit,
   pass two says which quad inside it. */
const pickBuf = new Uint8Array(4);
function readPixelAt(cx, cy, material, only) {
  const s = $('#stage'), rect = s.getBoundingClientRect(), pr = renderer.getPixelRatio();
  const px = Math.floor((cx - rect.left) * pr), py = Math.floor((cy - rect.top) * pr);
  const fw = Math.floor(rect.width * pr), fh = Math.floor(rect.height * pr);
  if (px < 0 || py < 0 || px >= fw || py >= fh) return null;
  if (only) for (const [k, c] of chunkMeshes) c.pickMesh.visible = (k === only);
  pickScene.overrideMaterial = material;
  camera.setViewOffset(fw, fh, px, py, 1, 1);
  renderer.setRenderTarget(pickTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(pickScene, camera);
  renderer.readRenderTargetPixels(pickTarget, 0, 0, 1, 1, pickBuf);
  renderer.setRenderTarget(null);
  camera.clearViewOffset();
  pickScene.overrideMaterial = null;
  if (only) for (const c of chunkMeshes.values()) c.pickMesh.visible = true;
  needsRender = true;
  if (pickBuf[3] < 32) return null;
  return pickBuf[0] + pickBuf[1] * 256 + pickBuf[2] * 65536;
}
const _rc = new THREE.Raycaster();
function pickFast(cx, cy) {
  if (!chunkMeshes.size) return null;
  const ord = readPixelAt(cx, cy, MATS.pickChunk, null);
  if (!ord) return null;
  const key = chunkByOrd.get(ord);
  if (!key) return null;
  const c = chunkMeshes.get(key);
  if (!c) return null;
  const q = readPixelAt(cx, cy, MATS.pick, key);
  if (q === null || q >= c.blk.length) return null;

  const d = c.dir[q], ax = d >> 1, neg = d & 1;
  const n = [0, 0, 0]; n[ax] = neg ? -1 : 1;
  const base = [c.cell[q * 3], c.cell[q * 3 + 1], c.cell[q * 3 + 2]];

  /* A merged quad can span many blocks, so the quad's own corner is not the
     block under the finger. Meet the quad's plane with the camera ray and
     round down to find the exact cell. */
  const stage = $('#stage'), rect = stage.getBoundingClientRect();
  _rc.setFromCamera({
    x: ((cx - rect.left) / rect.width) * 2 - 1,
    y: -((cy - rect.top) / rect.height) * 2 + 1
  }, camera);
  const o = [_rc.ray.origin.x, _rc.ray.origin.y, _rc.ray.origin.z];
  const dv = [_rc.ray.direction.x, _rc.ray.direction.y, _rc.ray.direction.z];
  const cell = base.slice();
  if (Math.abs(dv[ax]) > 1e-9) {
    const plane = base[ax] + (neg ? 0 : 1);
    const t = (plane - o[ax]) / dv[ax];
    if (t > 0) {
      for (let i = 0; i < 3; i++) {
        if (i === ax) continue;
        cell[i] = Math.floor(o[i] + dv[i] * t);
      }
    }
  }
  cell[0] = clamp(cell[0], 0, W - 1);
  cell[1] = clamp(cell[1], 0, H - 1);
  cell[2] = clamp(cell[2], 0, L - 1);
  return { x: cell[0], y: cell[1], z: cell[2], n, block: palette[c.blk[q]] };
}

/* ---------------------------------------------------------------- tools */
function setTool(t) {
  tool = t;
  for (const [id, name] of [['tOrbit', 'orbit'], ['tPlace', 'place'], ['tBreak', 'break'], ['tFill', 'fill'], ['tPick', 'pick']]) {
    $('#' + id).setAttribute('aria-pressed', name === t ? 'true' : 'false');
  }
  if (t === 'fill') { sel = { a: null, b: null }; updateSel(); banner('Tap one corner, then the opposite corner'); }
  else banner(null);
}
function banner(txt, cancel) {
  const b = $('#banner');
  if (!txt) { b.hidden = true; return; }
  b.hidden = false; $('#bannerTxt').textContent = txt;
  $('#bannerCancel').hidden = !cancel;
}

async function onTap(cx, cy) {
  const hit = pickFast(cx, cy);
  if (!hit) {
    if (tool === 'orbit') { $('#hudBlock').textContent = 'Nothing there'; $('#hudCoord').textContent = ''; }
    return;
  }
  $('#hudBlock').textContent = prettyName(hit.block);
  $('#hudCoord').textContent = `X ${hit.x}  Y ${hit.y}  Z ${hit.z}`;

  if (tool === 'pick') { selectBlock(hit.block); setTool('place'); return; }
  if (tool === 'place') {
    const p = { x: hit.x + hit.n[0], y: hit.y + hit.n[1], z: hit.z + hit.n[2] };
    if (p.x < 0 || p.y < 0 || p.z < 0 || p.x >= W || p.y >= H || p.z >= L) return;
    await applyEdit([{ ...p, block: selectedBlock }]);
    return;
  }
  if (tool === 'break') { await applyEdit([{ x: hit.x, y: hit.y, z: hit.z, block: AIR }]); return; }
  if (tool === 'fill') {
    const p = sel.a === null ? hit : hit;
    if (sel.a === null) { sel.a = { x: p.x, y: p.y, z: p.z }; banner('Now tap the opposite corner'); }
    else { sel.b = { x: p.x, y: p.y, z: p.z }; banner(null); }
    updateSel();
  }
}

function updateSel() {
  const a = sel.a, b = sel.b || sel.a;
  if (!a) { selBox.visible = false; $('#selInfo').textContent = 'Pick the FILL tool, then tap two corners.'; $('#fillActions').hidden = true; return; }
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  const z0 = Math.min(a.z, b.z), z1 = Math.max(a.z, b.z);
  const w = x1 - x0 + 1, h = y1 - y0 + 1, d = z1 - z0 + 1;
  selBox.geometry.dispose();
  selBox.geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d));
  selBox.position.set(x0 + w / 2, y0 + h / 2, z0 + d / 2);
  selBox.visible = true;
  $('#selInfo').innerHTML = `<b>${w} &times; ${h} &times; ${d}</b> &middot; ${(w * h * d).toLocaleString()} blocks` +
    `<br><span class="mono" style="font-size:11px;color:var(--faint)">from ${x0},${y0},${z0} to ${x1},${y1},${z1}</span>`;
  $('#fillActions').hidden = !sel.b;
  needsRender = true;
}

/* ---------------------------------------------------------------- edits */
async function applyEdit(ops) {
  const r = await call({ op: 'edit', ops });
  palette = r.palette;
  for (const c of r.chunks) applyChunk(c);
  if (r.undo.length) { pushUndo(r.undo); markDirty(); }
}
async function doFill(block, hollow) {
  if (!sel.a || !sel.b) return;
  showBoot('Filling');
  const r = await call({
    op: 'fill', x0: sel.a.x, y0: sel.a.y, z0: sel.a.z, x1: sel.b.x, y1: sel.b.y, z1: sel.b.z,
    block, hollow: !!hollow
  });
  palette = r.palette;
  for (const c of r.chunks) applyChunk(c);
  if (r.undo.length) { pushUndo(r.undo); markDirty(); }
  hideBoot();
  toast(`${r.changed.toLocaleString()} blocks changed`);
}
function pushUndo(undo) { undoStack.push(undo); if (undoStack.length > 60) undoStack.shift(); redoStack.length = 0; syncUndo(); }
function syncUndo() { $('#btnUndo').disabled = !undoStack.length; $('#btnRedo').disabled = !redoStack.length; }
async function undo() {
  const ops = undoStack.pop(); if (!ops) return;
  const r = await call({ op: 'edit', ops });
  palette = r.palette;
  for (const c of r.chunks) applyChunk(c);
  redoStack.push(r.undo); syncUndo(); markDirty();
}
async function redo() {
  const ops = redoStack.pop(); if (!ops) return;
  const r = await call({ op: 'edit', ops });
  palette = r.palette;
  for (const c of r.chunks) applyChunk(c);
  undoStack.push(r.undo); syncUndo(); markDirty();
}

/* ---------------------------------------------------------------- loading */
function showBoot(txt) { $('#boot').hidden = false; $('#bootTxt').textContent = txt; $('#bootBar').style.width = '0%'; }
function bootProg(p) { $('#bootBar').style.width = Math.round(p * 100) + '%'; }
function hideBoot() { $('#boot').hidden = true; }
function toast(msg) {
  $('#hudBlock').textContent = msg;
  $('#hudCoord').textContent = '';
}

async function afterLoad(info, name) {
  W = info.W; H = info.H; L = info.L; CS = info.CS; nChunks = info.chunks; palette = info.palette;
  projectName = name || projectName;
  $('#projName').textContent = projectName;
  $('#projDims').textContent = `${W} × ${H} × ${L}`;
  yMin = 0; yMax = H - 1;
  undoStack.length = 0; redoStack.length = 0; syncUndo();
  sel = { a: null, b: null }; updateSel();

  clearChunks();
  const bounds = scene.getObjectByName('bounds');
  bounds.geometry.dispose();
  bounds.geometry = new THREE.BoxGeometry(W, H, L);
  bounds.position.set(W / 2, H / 2, L / 2);

  resetView(); resize(); paintSlice();
  showBoot('Building the model');
  try {
    await stream({ op: 'meshAll' }, (part) => {
      for (const c of part.chunks) applyChunk(c);
      bootProg(part.progress);
    });
  } catch (err) {
    fatal('The model could not be drawn.', err.message); return;
  }
  hideBoot();
  refreshStats();
}

/* ---------------------------------------------------------------- slice */
function paintSlice() {
  const track = $('#track'), toPct = y => 1 - (y / Math.max(1, H - 1));
  const lo = toPct(yMin), hi = toPct(yMax);
  $('#hLo').style.top = lo * 100 + '%';
  $('#hHi').style.top = hi * 100 + '%';
  $('#fill').style.top = hi * 100 + '%';
  $('#fill').style.height = (lo - hi) * 100 + '%';
  $('#yLo').textContent = yMin; $('#yHi').textContent = yMax;
  MATS.solid.uniforms.uYMin.value = yMin;
  MATS.solid.uniforms.uYMax.value = yMax;
  MATS.pick.uniforms.uYMin.value = yMin;
  MATS.pick.uniforms.uYMax.value = yMax;
  MATS.pickChunk.uniforms.uYMin.value = yMin;
  MATS.pickChunk.uniforms.uYMax.value = yMax;
  needsRender = true;
  void track;
}
function initSlice() {
  const track = $('#track');
  const grab = (handle, isLo) => {
    handle.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const move = ev => {
        const r = track.getBoundingClientRect();
        const y = Math.round((1 - clamp((ev.clientY - r.top) / r.height, 0, 1)) * (H - 1));
        if (isLo) yMin = Math.min(y, yMax); else yMax = Math.max(y, yMin);
        paintSlice();
      };
      const end = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
  };
  grab($('#hLo'), true); grab($('#hHi'), false);
}

/* ---------------------------------------------------------------- blocks panel */
let catFilter = 'All';
function prettyName(id) {
  const b = BY_ID.get(id) || BY_ID.get(id.split('[')[0]);
  if (b) return b.name;
  return id.replace('minecraft:', '').replace(/_/g, ' ').replace(/\[.*/, '');
}
function selectBlock(id) {
  selectedBlock = id;
  const b = BY_ID.get(id) || BY_ID.get(id.split('[')[0]);
  $('#blockName').innerHTML = `<b>${prettyName(id)}</b><span class="id">${id}</span>`;
  $('#repTo').textContent = id;
  for (const el of document.querySelectorAll('.bk')) el.setAttribute('aria-pressed', el.dataset.id === id ? 'true' : 'false');
  void b;
}
function renderBlocks() {
  const q = $('#blockSearch').value.toLowerCase().trim();
  const grid = $('#blockGrid');
  const list = BLOCKS.filter(b => {
    if (b.cat === 'Special') return false;
    if (catFilter !== 'All' && b.cat !== catFilter) return false;
    if (q && !b.name.toLowerCase().includes(q) && !b.id.includes(q)) return false;
    return true;
  }).slice(0, 400);
  grid.innerHTML = list.map(b =>
    `<button class="bk" data-id="${b.id}" title="${b.name}" style="background:${b.c}" aria-pressed="${b.id === selectedBlock}"></button>`
  ).join('') || '<p class="empty">No block matches that.</p>';
  for (const el of grid.querySelectorAll('.bk')) {
    el.addEventListener('click', () => { selectBlock(el.dataset.id); if (tool === 'orbit') setTool('place'); });
  }
}
function initBlocks() {
  const cats = ['All', ...CATEGORIES.filter(c => c !== 'Special')];
  $('#cats').innerHTML = cats.map(c => `<button data-cat="${c}" aria-pressed="${c === 'All'}">${c}</button>`).join('');
  for (const el of $('#cats').querySelectorAll('button')) {
    el.addEventListener('click', () => {
      catFilter = el.dataset.cat;
      for (const e2 of $('#cats').querySelectorAll('button')) e2.setAttribute('aria-pressed', e2 === el ? 'true' : 'false');
      renderBlocks();
    });
  }
  $('#blockSearch').addEventListener('input', renderBlocks);
  renderBlocks(); selectBlock(selectedBlock);
}

/* ---------------------------------------------------------------- stats */
let statRows = [];
async function refreshStats() {
  const r = await call({ op: 'stats' });
  statRows = r.rows;
  $('#matTotal').textContent = `${r.total.toLocaleString()} blocks · ${r.rows.length} types`;
  $('#matList').innerHTML = r.rows.slice(0, 60).map(x => {
    const st = Math.floor(x.n / 64), rem = x.n % 64;
    return `<div class="row"><span class="sw" style="background:${colourOf(x.block)}"></span>` +
      `<span class="t">${prettyName(x.block)}</span>` +
      `<span class="c mono">${st ? st + 'st ' : ''}${rem || (st ? '' : 0)}</span>` +
      `<span class="n mono">${x.n.toLocaleString()}</span></div>`;
  }).join('') || '<p class="empty">Nothing placed yet.</p>';
  const sel2 = $('#repFrom');
  sel2.innerHTML = r.rows.slice(0, 120).map(x => `<option value="${x.block}">${prettyName(x.block)} (${x.n.toLocaleString()})</option>`).join('');
}
function copyMats() {
  const lines = [`${projectName} — ${W}x${H}x${L}`, ''];
  for (const x of statRows) {
    const st = Math.floor(x.n / 64), rem = x.n % 64;
    lines.push(`${st ? st + ' stacks ' : ''}${rem ? '+ ' + rem : ''}  ${prettyName(x.block)}`.trim());
  }
  copyText(lines.join('\n'), 'Shopping list copied');
}

/* ---------------------------------------------------------------- projects */
let statT = null;
function scheduleStats() { clearTimeout(statT); statT = setTimeout(refreshStats, 700); }
function markDirty() { dirty = true; scheduleSave(); scheduleStats(); }
let saveT = null;
function scheduleSave() { clearTimeout(saveT); saveT = setTimeout(saveProject, 2500); }
async function saveProject() {
  if (!dirty) return;
  const snap = await call({ op: 'snapshot' });
  projectId = await Projects.save({
    id: projectId, name: projectName, W: snap.W, H: snap.H, L: snap.L,
    palette: snap.palette, states: snap.states
  });
  dirty = false;
  renderProjects();
}
async function renderProjects() {
  const list = await Projects.list();
  $('#projList').innerHTML = list.length ? list.map(p =>
    `<div class="pcard" data-id="${p.id}">
       <div class="nm">${p.name}</div>
       <div class="meta mono">${p.W}×${p.H}×${p.L} · ${new Date(p.updated).toLocaleDateString()}</div>
       <div class="acts"><button data-act="open">Open</button><button data-act="del">Delete</button></div>
     </div>`).join('') : '<p class="empty">Nothing saved yet. Builds you make are kept on this device.</p>';
  for (const b of $('#projList').querySelectorAll('button[data-act]')) {
    b.addEventListener('click', async () => {
      const card = b.closest('.pcard'), id = Number(card.dataset.id);
      if (b.dataset.act === 'del') { await Projects.remove(id); renderProjects(); return; }
      const p = await Projects.get(id);
      showBoot('Opening');
      const info = await call({ op: 'loadState', W: p.W, H: p.H, L: p.L, palette: p.palette, states: p.states, ao: $('#aoToggle').checked }, [p.states]);
      projectId = id; dirty = false;
      await afterLoad(info, p.name);
    });
  }
}

/* ---------------------------------------------------------------- io */
async function importFile(file) {
  showBoot('Reading the schematic');
  try {
    const buf = await file.arrayBuffer();
    const info = await call({ op: 'import', buffer: buf, ao: $('#aoToggle').checked }, [buf]);
    projectId = null; dirty = true;
    await afterLoad(info, info.name || file.name.replace(/\.[^.]+$/, ''));
    $('#ioMsg').innerHTML = `<div class="warn ok">Imported ${info.W}×${info.H}×${info.L}.</div>`;
    scheduleSave();
  } catch (err) {
    hideBoot();
    $('#ioMsg').innerHTML = `<div class="warn bad">Could not read that file: ${err.message}</div>`;
  }
}
async function exportFile() {
  const name = ($('#xName').value || projectName || 'Build').replace(/[^\w \-.]/g, '').trim() || 'Build';
  $('#xMsg').innerHTML = '<div class="warn">Building the file…</div>';
  try {
    const r = await call({ op: 'export', name, author: 'elsazon' });
    const blob = new Blob([r.bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name + '.litematic';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    $('#xMsg').innerHTML = `<div class="warn ok">${r.nonAir.toLocaleString()} blocks, ${r.palette} types. Saved as <b>${name}.litematic</b>.</div>`;
  } catch (err) {
    $('#xMsg').innerHTML = `<div class="warn bad">Export failed: ${err.message}</div>`;
  }
}

/* ---------------------------------------------------------------- reference image */
let refMesh = null, refTex = null;
function refUpdate() {
  if (!refMesh) return;
  const face = $('#refFace').value;
  const w = Math.max(1, parseInt($('#refW').value, 10) || 64);
  const h = Math.max(1, parseInt($('#refH').value, 10) || 48);
  const x = parseInt($('#refX').value, 10) || 0;
  const y = parseInt($('#refY').value, 10) || 0;
  const z = parseInt($('#refZ').value, 10) || 0;
  refMesh.geometry.dispose();
  refMesh.geometry = new THREE.PlaneGeometry(w, h);
  refMesh.rotation.set(0, 0, 0);
  if (face === 'x') refMesh.rotation.y = Math.PI / 2;
  if (face === 'y') refMesh.rotation.x = -Math.PI / 2;
  refMesh.position.set(x + (face === 'x' ? 0 : w / 2), face === 'y' ? y : y + h / 2, z + (face === 'x' ? w / 2 : 0));
  refMesh.material.opacity = (parseInt($('#refOp').value, 10) || 60) / 100;
  needsRender = true;
}
function refLoadFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    if (refTex) refTex.dispose();
    refTex = new THREE.Texture(img); refTex.needsUpdate = true;
    if (!refMesh) {
      refMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: refTex, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
      scene.add(refMesh);
    } else { refMesh.material.map = refTex; refMesh.material.needsUpdate = true; }
    const ratio = img.height / img.width;
    $('#refW').value = Math.min(W, 64);
    $('#refH').value = Math.max(1, Math.round(Math.min(W, 64) * ratio));
    $('#refX').value = 0; $('#refY').value = 0; $('#refZ').value = 0;
    $('#refCtl').hidden = false; $('#refClear').hidden = false;
    refUpdate();
    URL.revokeObjectURL(url);
  };
  img.src = url;
}
function refRemove() {
  if (refMesh) { scene.remove(refMesh); refMesh.geometry.dispose(); refMesh.material.dispose(); refMesh = null; }
  if (refTex) { refTex.dispose(); refTex = null; }
  $('#refCtl').hidden = true; $('#refClear').hidden = true; needsRender = true;
}

/* ---------------------------------------------------------------- build board */
function copyForBoard() {
  const total = statRows.reduce((a, r) => a + r.n, 0);
  const top = statRows.slice(0, 8).map(r => {
    const st = Math.floor(r.n / 64);
    return `${prettyName(r.block)} ${st ? st + ' stacks' : r.n}`;
  });
  const text = [
    `Name: ${projectName}`,
    `Size: ${W} \u00d7 ${H} \u00d7 ${L}, ${total.toLocaleString()} blocks`,
    `Block types: ${statRows.length}`,
    `Main materials: ${top.join(', ')}`,
    `Made with: Claude (Blockwright)`
  ].join('\n');
  copyText(text, 'Copied for the Build Board');
}
function copyText(text, okMsg) {
  const done = () => toast(okMsg);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('Copy did not work here'); }
  ta.remove();
}

/* ---------------------------------------------------------------- render */
function tick() {
  requestAnimationFrame(tick);
  if (!needsRender) return;
  needsRender = false;
  renderer.setRenderTarget(null);
  renderer.setClearColor(0x12100d, 1);
  renderer.render(scene, camera);
}

/* ---------------------------------------------------------------- wiring */
function initUI() {
  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', () => {
      for (const x of document.querySelectorAll('.tab')) x.setAttribute('aria-selected', x === t ? 'true' : 'false');
      for (const p of document.querySelectorAll('.pane')) p.hidden = p.id !== t.dataset.pane;
    });
  }
  $('#tOrbit').onclick = () => setTool('orbit');
  $('#tPlace').onclick = () => setTool('place');
  $('#tBreak').onclick = () => setTool('break');
  $('#tFill').onclick = () => setTool('fill');
  $('#tPick').onclick = () => setTool('pick');
  $('#tHome').onclick = () => resetView();
  $('#bannerCancel').onclick = () => { sel = { a: null, b: null }; updateSel(); setTool('orbit'); };
  $('#btnUndo').onclick = undo;
  $('#btnRedo').onclick = redo;
  $('#btnMenu').onclick = () => { document.querySelector('.tab[data-pane="pFiles"]').click(); };
  $('#btnOpen').onclick = () => $('#fileInput').click();

  $('#doFill').onclick = () => doFill(selectedBlock, false);
  $('#doHollow').onclick = () => doFill(selectedBlock, true);
  $('#doClear').onclick = () => doFill(AIR, false);
  $('#doReplace').onclick = async () => {
    const from = $('#repFrom').value;
    if (!from) return;
    showBoot('Replacing');
    const r = await call({ op: 'replace', from, to: selectedBlock });
    palette = r.palette;
    for (const c of r.chunks) applyChunk(c);
    if (r.undo.length) { pushUndo(r.undo); markDirty(); }
    hideBoot(); toast(`${r.changed.toLocaleString()} blocks swapped`);
    refreshStats();
  };
  $('#copyMats').onclick = copyMats;
  $('#copyBoard').onclick = copyForBoard;
  $('#refLoad').onclick = () => $('#refInput').click();
  $('#refInput').onchange = e => { const f = e.target.files[0]; if (f) refLoadFile(f); e.target.value = ''; };
  $('#refClear').onclick = refRemove;
  for (const id of ['refFace', 'refX', 'refY', 'refZ', 'refW', 'refH', 'refOp'])
    $('#' + id).addEventListener('input', refUpdate);
  $('#aoToggle').onchange = async () => {
    await call({ op: 'setQuality', ao: $('#aoToggle').checked });
    showBoot('Redrawing');
    clearChunks();
    await stream({ op: 'meshAll' }, part => { for (const c of part.chunks) applyChunk(c); bootProg(part.progress); });
    hideBoot();
  };

  $('#btnNew').onclick = () => $('#dlgNew').showModal();
  $('#nGo').onclick = async () => {
    const w = clamp(parseInt($('#nW').value, 10) || 64, 1, 512);
    const h = clamp(parseInt($('#nH').value, 10) || 48, 1, 384);
    const l = clamp(parseInt($('#nL').value, 10) || 64, 1, 512);
    $('#dlgNew').close();
    showBoot('Creating');
    const info = await call({ op: 'newProject', W: w, H: h, L: l, ao: $('#aoToggle').checked });
    projectId = null; dirty = true;
    await afterLoad(info, $('#nName').value || 'New build');
    if ($('#nFloor').value === 'grid') {
      sel = { a: { x: 0, y: 0, z: 0 }, b: { x: w - 1, y: 0, z: l - 1 } };
      await doFill('minecraft:smooth_stone', false);
      sel = { a: null, b: null }; updateSel();
    }
    document.querySelector('.tab[data-pane="pBlocks"]').click();
    scheduleSave();
  };
  for (const b of document.querySelectorAll('[data-close]')) b.onclick = e => e.target.closest('dialog').close();

  $('#btnImport').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = e => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ''; };
  $('#btnExport').onclick = () => { $('#xName').value = projectName; $('#xMsg').innerHTML = ''; $('#dlgExport').showModal(); };
  $('#xGo').onclick = exportFile;

  // drag a file anywhere onto the window
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer.files[0]; if (!f) return;
    if (/^image\//.test(f.type)) { refLoadFile(f); document.querySelector('.tab[data-pane="pBuild"]').click(); }
    else importFile(f);
  });

  // bottom sheet drag on narrow screens
  const grip = $('#grip');
  grip.addEventListener('pointerdown', e => {
    grip.setPointerCapture(e.pointerId);
    const mv = ev => { $('#panel').style.height = clamp(innerHeight - ev.clientY, 120, innerHeight * 0.8) + 'px'; resize(); };
    const up2 = () => { grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up2); };
    grip.addEventListener('pointermove', mv); grip.addEventListener('pointerup', up2);
  });
}

/* ---------------------------------------------------------------- start */
async function start() {
  initThree(); initUI(); initBlocks(); initSlice();
  if (!startWorker()) return;
  // make sure the engine actually answers before trusting the interface
  showBoot('Starting');
  try {
    await Promise.race([
      call({ op: 'newProject', W: 4, H: 4, L: 4, ao: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('no answer after 15 seconds')), 15000))
    ]);
  } catch (err) {
    fatal('The app could not start its engine, so the buttons will not respond.', err.message);
    return;
  }
  await renderProjects();
  const last = await Projects.last();
  if (last) {
    showBoot('Opening your last build');
    const info = await call({ op: 'loadState', W: last.W, H: last.H, L: last.L, palette: last.palette, states: last.states, ao: true }, [last.states]);
    projectId = last.id;
    await afterLoad(info, last.name);
  } else {
    const info = await call({ op: 'newProject', W: 64, H: 48, L: 64, ao: true });
    await afterLoad(info, 'New build');
    sel = { a: { x: 0, y: 0, z: 0 }, b: { x: 63, y: 0, z: 63 } };
    await doFill('minecraft:smooth_stone', false);
    sel = { a: null, b: null }; updateSel();
    dirty = true; scheduleSave();
  }
  setTool('orbit');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
start();

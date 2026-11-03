/* Worker: owns the voxel data, meshes it, applies edits.
   Keeping the blocks here means an edit is a small message in and a chunk of
   geometry back out, instead of shipping megabytes across on every click. */
import { readLitematic, writeLitematic, AIR } from './litematic.js';
import { colourOf } from './blocks.js';

const CS = 32;                       // chunk edge, for meshing and drawing
const PS = CS + 2;
const AXES = [[0, 1, 2], [1, 0, 2], [2, 0, 1]];
const SHADE = [0.82, 0.68, 1.00, 0.48, 0.90, 0.74];   // +x -x +y -y +z -z
const AOF = [0.42, 0.62, 0.81, 1.00];

let W = 0, H = 0, L = 0;
let palette = [AIR];                 // index -> block state string
let palIndex = new Map([[AIR, 0]]);
let states = null;                   // Uint16Array, index y*W*L + z*W + x
let useAO = true;
let palRGB = new Uint8Array(3);

const idx = (x, y, z) => y * W * L + z * W + x;
const inBounds = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < W && y < H && z < L;

function rebuildPalRGB() {
  palRGB = new Uint8Array(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    const h = colourOf(palette[i]).replace('#', '');
    palRGB[i * 3] = parseInt(h.slice(0, 2), 16);
    palRGB[i * 3 + 1] = parseInt(h.slice(2, 4), 16);
    palRGB[i * 3 + 2] = parseInt(h.slice(4, 6), 16);
  }
}
function palAdd(name) {
  let i = palIndex.get(name);
  if (i === undefined) { i = palette.length; palette.push(name); palIndex.set(name, i); rebuildPalRGB(); }
  return i;
}
function isAirName(n) { return n === AIR || n === 'minecraft:cave_air' || n === 'minecraft:void_air'; }
let airFlags = new Uint8Array(1);
function rebuildAirFlags() {
  airFlags = new Uint8Array(palette.length);
  for (let i = 0; i < palette.length; i++) airFlags[i] = isAirName(palette[i].split('[')[0]) ? 1 : 0;
}

function chunkCounts() {
  return [Math.ceil(W / CS), Math.ceil(H / CS), Math.ceil(L / CS)];
}
function chunkKey(cx, cy, cz) { const [nx, ny] = chunkCounts(); return (cz * ny + cy) * nx + cx; }

/* ---------------------------------------------------------------- meshing */
const pad = new Uint8Array(PS * PS * PS);
const Pi = (x, y, z) => (x * PS + y) * PS + z;
const maskKey = new Int32Array(CS * CS);
const maskAO = new Uint8Array(CS * CS);
const maskBlk = new Uint16Array(CS * CS);
function ao(s1, s2, c) { return (s1 && s2) ? 0 : 3 - (s1 + s2 + c); }

function fillPad(cx, cy, cz) {
  pad.fill(0);
  const x0 = cx * CS - 1, y0 = cy * CS - 1, z0 = cz * CS - 1;
  for (let x = 0; x < PS; x++) {
    const wx = x0 + x; if (wx < 0 || wx >= W) continue;
    for (let y = 0; y < PS; y++) {
      const wy = y0 + y; if (wy < 0 || wy >= H) continue;
      const row = wy * W * L + z0 * W + wx, pb = (x * PS + y) * PS;
      for (let z = 0; z < PS; z++) {
        const wz = z0 + z; if (wz < 0 || wz >= L) continue;
        pad[pb + z] = airFlags[states[row + z * W]] ? 0 : 1;
      }
    }
  }
}

function meshChunk(cx, cy, cz) {
  fillPad(cx, cy, cz);
  const pos = [], col = [], blk = [], cell = [], dirs = [];
  let quads = 0;
  for (let a = 0; a < 3; a++) {
    const [d, u, v] = AXES[a];
    for (let sg = 1; sg >= -1; sg -= 2) {
      const dirId = d * 2 + (sg > 0 ? 0 : 1);
      const nn = [0, 0, 0]; nn[d] = sg;
      const uu = [0, 0, 0]; uu[u] = 1;
      const vv = [0, 0, 0]; vv[v] = 1;
      const shade = SHADE[dirId];
      for (let s = 0; s < CS; s++) {
        maskKey.fill(0);
        let any = false;
        for (let iu = 0; iu < CS; iu++) {
          for (let iv = 0; iv < CS; iv++) {
            const c = [0, 0, 0]; c[d] = s; c[u] = iu; c[v] = iv;
            const wx = cx * CS + c[0], wy = cy * CS + c[1], wz = cz * CS + c[2];
            if (wx >= W || wy >= H || wz >= L) continue;
            const px = c[0] + 1, py = c[1] + 1, pz = c[2] + 1;
            if (!pad[Pi(px, py, pz)]) continue;
            const ax = px + nn[0], ay = py + nn[1], az = pz + nn[2];
            if (pad[Pi(ax, ay, az)]) continue;
            const b = states[idx(wx, wy, wz)];
            const mi = iu * CS + iv;
            maskBlk[mi] = b;
            if (useAO) {
              const g = (o1, o2, o3) => pad[Pi(ax + o1, ay + o2, az + o3)];
              const s1p = g(uu[0], uu[1], uu[2]), s1m = g(-uu[0], -uu[1], -uu[2]);
              const s2p = g(vv[0], vv[1], vv[2]), s2m = g(-vv[0], -vv[1], -vv[2]);
              const a00 = ao(s1m, s2m, g(-uu[0] - vv[0], -uu[1] - vv[1], -uu[2] - vv[2]));
              const a10 = ao(s1p, s2m, g(uu[0] - vv[0], uu[1] - vv[1], uu[2] - vv[2]));
              const a11 = ao(s1p, s2p, g(uu[0] + vv[0], uu[1] + vv[1], uu[2] + vv[2]));
              const a01 = ao(s1m, s2p, g(-uu[0] + vv[0], -uu[1] + vv[1], -uu[2] + vv[2]));
              maskAO[mi] = a00 | (a10 << 2) | (a11 << 4) | (a01 << 6);
              maskKey[mi] = (a00 === a10 && a00 === a11 && a00 === a01)
                ? (b * 4 + a00 + 1) : -(1 + mi);
            } else { maskAO[mi] = 255; maskKey[mi] = b + 1; }
            any = true;
          }
        }
        if (!any) continue;
        for (let iu = 0; iu < CS; iu++) {
          for (let iv = 0; iv < CS;) {
            const mi = iu * CS + iv, k = maskKey[mi];
            if (k === 0) { iv++; continue; }
            let hv = 1, wu = 1;
            if (k > 0) {
              while (iv + hv < CS && maskKey[iu * CS + iv + hv] === k) hv++;
              outer: while (iu + wu < CS) {
                for (let q = 0; q < hv; q++) if (maskKey[(iu + wu) * CS + iv + q] !== k) break outer;
                wu++;
              }
            }
            const aop = maskAO[mi], b = maskBlk[mi];
            for (let p = 0; p < wu; p++) for (let q = 0; q < hv; q++) maskKey[(iu + p) * CS + iv + q] = 0;

            const c0 = [0, 0, 0]; c0[d] = s; c0[u] = iu; c0[v] = iv;
            const base = [cx * CS + c0[0], cy * CS + c0[1], cz * CS + c0[2]];
            const p0 = base.slice(); p0[d] += (sg > 0 ? 1 : 0);
            const corners = [p0.slice(), p0.slice(), p0.slice(), p0.slice()];
            corners[1][u] += wu; corners[2][u] += wu; corners[2][v] += hv; corners[3][v] += hv;
            const r = palRGB[b * 3], g2 = palRGB[b * 3 + 1], b2 = palRGB[b * 3 + 2];
            for (let kk = 0; kk < 4; kk++) {
              const f = shade * (aop === 255 ? 1 : AOF[(aop >> (kk * 2)) & 3]);
              pos.push(corners[kk][0], corners[kk][1], corners[kk][2]);
              col.push(r * f | 0, g2 * f | 0, b2 * f | 0);
            }
            blk.push(b); cell.push(base[0], base[1], base[2]); dirs.push(dirId);
            quads++; iv += hv;
          }
        }
      }
    }
  }
  return {
    cx, cy, cz, quads,
    pos: new Int16Array(pos), col: new Uint8Array(col),
    blk: new Uint16Array(blk), cell: new Int16Array(cell), dir: new Uint8Array(dirs)
  };
}

function meshList(list, post) {
  const out = [];
  for (const [cx, cy, cz] of list) out.push(meshChunk(cx, cy, cz));
  return out;
}
function transfersOf(chunks) {
  const t = [];
  for (const c of chunks) t.push(c.pos.buffer, c.col.buffer, c.blk.buffer, c.cell.buffer, c.dir.buffer);
  return t;
}

/* ---------------------------------------------------------------- edits */
function setBlock(x, y, z, name) {
  if (!inBounds(x, y, z)) return null;
  const pi = palAdd(name);
  if (airFlags.length !== palette.length) rebuildAirFlags();
  const i = idx(x, y, z);
  const prev = states[i];
  if (prev === pi) return null;
  states[i] = pi;
  return prev;
}
function dirtyFor(set, x, y, z) {
  const cx = (x / CS) | 0, cy = (y / CS) | 0, cz = (z / CS) | 0;
  const [nx, ny, nz] = chunkCounts();
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    // only touch a neighbour chunk when the edit sits on the shared face
    const ax = cx + dx, ay = cy + dy, az = cz + dz;
    if (ax < 0 || ay < 0 || az < 0 || ax >= nx || ay >= ny || az >= nz) continue;
    if (dx && ((x % CS !== 0 || dx !== -1) && (x % CS !== CS - 1 || dx !== 1))) continue;
    if (dy && ((y % CS !== 0 || dy !== -1) && (y % CS !== CS - 1 || dy !== 1))) continue;
    if (dz && ((z % CS !== 0 || dz !== -1) && (z % CS !== CS - 1 || dz !== 1))) continue;
    set.add(chunkKey(ax, ay, az));
  }
}
function keyToChunk(k) {
  const [nx, ny] = chunkCounts();
  const cx = k % nx, rest = (k - cx) / nx, cy = rest % ny, cz = (rest - cy) / ny;
  return [cx, cy, cz];
}

/* ---------------------------------------------------------------- messages */
self.onmessage = async (e) => {
  const m = e.data, id = m.id;
  try {
    switch (m.op) {

      case 'newProject': {
        W = m.W; H = m.H; L = m.L; useAO = m.ao !== false;
        palette = [AIR]; palIndex = new Map([[AIR, 0]]);
        states = new Uint16Array(W * H * L);
        rebuildPalRGB(); rebuildAirFlags();
        self.postMessage({ id, ok: true, W, H, L, CS, chunks: chunkCounts(), palette });
        break;
      }

      case 'import': {
        const doc = await readLitematic(m.buffer);
        const reg = doc.regions[m.region || 0];
        let { W: rw, H: rh, L: rl } = reg;
        let crop = m.crop || null;
        W = crop ? crop.w : rw; H = crop ? crop.h : rh; L = crop ? crop.l : rl;
        palette = reg.palette.slice();
        if (palette[0] !== AIR) { palette.unshift(AIR); }
        palIndex = new Map(palette.map((n, i) => [n, i]));
        const shift = palette[0] === AIR && reg.palette[0] !== AIR ? 1 : 0;
        states = new Uint16Array(W * H * L);
        const ox = crop ? crop.x : 0, oy = crop ? crop.y : 0, oz = crop ? crop.z : 0;
        for (let y = 0; y < H; y++)
          for (let z = 0; z < L; z++) {
            const src = (y + oy) * rw * rl + (z + oz) * rw + ox;
            const dst = y * W * L + z * W;
            for (let x = 0; x < W; x++) states[dst + x] = reg.states[src + x] + shift;
          }
        useAO = m.ao !== false;
        rebuildPalRGB(); rebuildAirFlags();
        self.postMessage({
          id, ok: true, W, H, L, CS, chunks: chunkCounts(), palette,
          name: doc.name, regions: doc.regions.map(r => ({ name: r.name, W: r.W, H: r.H, L: r.L }))
        });
        break;
      }

      case 'loadState': {
        W = m.W; H = m.H; L = m.L; useAO = m.ao !== false;
        palette = m.palette.slice(); palIndex = new Map(palette.map((n, i) => [n, i]));
        states = new Uint16Array(m.states);
        rebuildPalRGB(); rebuildAirFlags();
        self.postMessage({ id, ok: true, W, H, L, CS, chunks: chunkCounts(), palette });
        break;
      }

      case 'meshAll': {
        const [nx, ny, nz] = chunkCounts();
        const total = nx * ny * nz;
        let done = 0;
        for (let cz = 0; cz < nz; cz++) {
          const batch = [];
          for (let cx = 0; cx < nx; cx++) for (let cy = 0; cy < ny; cy++) batch.push(meshChunk(cx, cy, cz));
          done += batch.length;
          self.postMessage({ id, chunks: batch, progress: done / total, done: done === total },
            transfersOf(batch));
        }
        if (total === 0) self.postMessage({ id, chunks: [], progress: 1, done: true });
        break;
      }

      case 'edit': {
        const dirty = new Set();
        const undo = [];
        for (const op of m.ops) {
          const prev = setBlock(op.x, op.y, op.z, op.block);
          if (prev === null) continue;
          undo.push({ x: op.x, y: op.y, z: op.z, block: palette[prev] });
          dirtyFor(dirty, op.x, op.y, op.z);
        }
        const chunks = [...dirty].map(keyToChunk).map(([a, b, c]) => meshChunk(a, b, c));
        self.postMessage({ id, ok: true, chunks, undo, palette }, transfersOf(chunks));
        break;
      }

      case 'fill': {
        const { x0, y0, z0, x1, y1, z1, block, hollow } = m;
        const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
        const ay = Math.min(y0, y1), by = Math.max(y0, y1);
        const az = Math.min(z0, z1), bz = Math.max(z0, z1);
        const dirty = new Set(); const undo = [];
        for (let x = ax; x <= bx; x++) for (let y = ay; y <= by; y++) for (let z = az; z <= bz; z++) {
          if (hollow && x > ax && x < bx && y > ay && y < by && z > az && z < bz) continue;
          const prev = setBlock(x, y, z, block);
          if (prev === null) continue;
          undo.push({ x, y, z, block: palette[prev] });
          dirtyFor(dirty, x, y, z);
        }
        const chunks = [...dirty].map(keyToChunk).map(([a, b, c]) => meshChunk(a, b, c));
        self.postMessage({ id, ok: true, chunks, undo, palette, changed: undo.length }, transfersOf(chunks));
        break;
      }

      case 'replace': {
        const from = palIndex.get(m.from), to = palAdd(m.to);
        rebuildAirFlags();
        if (from === undefined) { self.postMessage({ id, ok: true, chunks: [], undo: [], changed: 0, palette }); break; }
        const dirty = new Set(); const undo = [];
        for (let i = 0; i < states.length; i++) {
          if (states[i] !== from) continue;
          states[i] = to;
          const y = (i / (W * L)) | 0, r = i - y * W * L, z = (r / W) | 0, x = r - z * W;
          undo.push({ x, y, z, block: m.from });
          dirtyFor(dirty, x, y, z);
        }
        const chunks = [...dirty].map(keyToChunk).map(([a, b, c]) => meshChunk(a, b, c));
        self.postMessage({ id, ok: true, chunks, undo, palette, changed: undo.length }, transfersOf(chunks));
        break;
      }

      case 'setQuality': {
        useAO = !!m.ao;
        self.postMessage({ id, ok: true });
        break;
      }

      case 'query': {
        const ok = inBounds(m.x, m.y, m.z);
        self.postMessage({ id, ok: true, block: ok ? palette[states[idx(m.x, m.y, m.z)]] : null });
        break;
      }

      case 'stats': {
        const counts = new Map();
        for (let i = 0; i < states.length; i++) {
          const s = states[i];
          if (airFlags[s]) continue;
          counts.set(s, (counts.get(s) || 0) + 1);
        }
        const rows = [...counts.entries()]
          .map(([s, n]) => ({ block: palette[s], n }))
          .sort((a, b) => b.n - a.n);
        self.postMessage({ id, ok: true, rows, total: rows.reduce((a, r) => a + r.n, 0), W, H, L });
        break;
      }

      case 'snapshot': {
        const copy = states.slice();
        self.postMessage({ id, ok: true, W, H, L, palette, states: copy.buffer }, [copy.buffer]);
        break;
      }

      case 'export': {
        const res = await writeLitematic({
          name: m.name, author: m.author, W, H, L, palette, states, dataVersion: m.dataVersion
        });
        self.postMessage({ id, ok: true, bytes: res.bytes, nonAir: res.nonAir, palette: res.palette },
          [res.bytes.buffer]);
        break;
      }

      default:
        self.postMessage({ id, ok: false, error: 'unknown op ' + m.op });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
};

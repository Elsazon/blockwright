/* Litematica .litematic read + write, pure browser JS.
   Keeps full block states (stairs keep their facing, slabs their half) so a
   round trip through this editor does not flatten anything. */
export const AIR = 'minecraft:air';

/* ---------------------------------------------------------------- NBT read */
class Reader {
  constructor(buf) { this.d = new DataView(buf); this.u = new Uint8Array(buf); this.p = 0; }
  u8() { return this.u[this.p++]; }
  i16() { const v = this.d.getInt16(this.p); this.p += 2; return v; }
  i32() { const v = this.d.getInt32(this.p); this.p += 4; return v; }
  f32() { const v = this.d.getFloat32(this.p); this.p += 4; return v; }
  f64() { const v = this.d.getFloat64(this.p); this.p += 8; return v; }
  str() {
    const n = this.d.getUint16(this.p); this.p += 2;
    const s = utf8Decode(this.u.subarray(this.p, this.p + n)); this.p += n; return s;
  }
  payload(t) {
    switch (t) {
      case 1: { const v = this.d.getInt8(this.p); this.p += 1; return v; }
      case 2: return this.i16();
      case 3: return this.i32();
      case 4: { const hi = this.d.getInt32(this.p), lo = this.d.getUint32(this.p + 4); this.p += 8; return { hi, lo }; }
      case 5: return this.f32();
      case 6: return this.f64();
      case 7: { const n = this.i32(); const a = this.u.slice(this.p, this.p + n); this.p += n; return a; }
      case 8: return this.str();
      case 9: { const it = this.u8(), n = this.i32(), a = new Array(n); for (let i = 0; i < n; i++) a[i] = this.payload(it); return a; }
      case 10: { const o = {}; for (;;) { const tt = this.u8(); if (!tt) break; o[this.str()] = this.payload(tt); } return o; }
      case 11: { const n = this.i32(), a = new Int32Array(n); for (let i = 0; i < n; i++) { a[i] = this.d.getInt32(this.p); this.p += 4; } return a; }
      case 12: {
        const n = this.i32(); const hi = new Int32Array(n), lo = new Uint32Array(n);
        for (let i = 0; i < n; i++) { hi[i] = this.d.getInt32(this.p); lo[i] = this.d.getUint32(this.p + 4); this.p += 8; }
        return { __long: true, hi, lo, length: n };
      }
      default: throw new Error('Unknown NBT tag ' + t);
    }
  }
}
function utf8Decode(a) { return new TextDecoder('utf-8').decode(a); }
function utf8Encode(s) { return new TextEncoder().encode(s); }

function parseNBT(buf) { const r = new Reader(buf); const t = r.u8(); r.str(); return r.payload(t); }

/* ---------------------------------------------------------------- NBT write */
class Writer {
  constructor() { this.a = []; }
  u8(v) { this.a.push(v & 255); }
  i16(v) { this.a.push((v >> 8) & 255, v & 255); }
  i32(v) { this.a.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); }
  i64hl(hi, lo) { this.i32(hi); this.i32(lo); }
  str(s) { const e = utf8Encode(s); this.i16(e.length); for (let i = 0; i < e.length; i++) this.a.push(e[i]); }
  tag(t, name) { this.u8(t); this.str(name); }
  bytes() { return new Uint8Array(this.a); }
}
export const I = v => ({ t: 3, v: v | 0 });
export const Str = v => ({ t: 8, v: String(v) });
export const Long = ms => { const hi = Math.floor(ms / 4294967296), lo = ms >>> 0; return { t: 4, hi, lo }; };
export const LongArr = pairs => ({ t: 12, v: pairs });
export const List = (itemType, items) => ({ t: 9, it: itemType, v: items });
export const Comp = obj => ({ t: 10, v: obj });

function writeValue(w, node) {
  switch (node.t) {
    case 3: w.i32(node.v); break;
    case 4: w.i64hl(node.hi, node.lo); break;
    case 8: w.str(node.v); break;
    case 9: {
      w.u8(node.it); w.i32(node.v.length);
      for (const item of node.v) { if (node.it === 10) { writeCompoundBody(w, item.v !== undefined ? item.v : item); w.u8(0); } }
      break;
    }
    case 10: writeCompoundBody(w, node.v), w.u8(0); break;
    case 12: {
      w.i32(node.v.length);
      for (const [hi, lo] of node.v) w.i64hl(hi, lo);
      break;
    }
    default: throw new Error('cannot write tag ' + node.t);
  }
}
function writeCompoundBody(w, obj) {
  for (const k of Object.keys(obj)) {
    const node = obj[k];
    if (node === null || node === undefined) continue;
    w.tag(node.t, k);
    writeValue(w, node);
  }
}
function writeNBT(root) {
  const w = new Writer();
  w.tag(10, '');
  writeCompoundBody(w, root);
  w.u8(0);
  return w.bytes();
}

/* ---------------------------------------------------------------- gzip */
export async function gunzip(bytes) {
  if (typeof DecompressionStream === 'function') {
    const ds = new DecompressionStream('gzip');
    const ab = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(ab);
  }
  return inflateGzip(bytes);                        // fallback for older Safari
}
export async function gzip(bytes) {
  if (typeof CompressionStream === 'function') {
    const cs = new CompressionStream('gzip');
    const ab = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
    return new Uint8Array(ab);
  }
  return gzipStored(bytes);                         // valid gzip, just uncompressed
}
let CRC = null;
function crcTable() {
  if (CRC) return CRC;
  CRC = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); CRC[n] = c >>> 0; }
  return CRC;
}
export function crc32(b) { const t = crcTable(); let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function gzipStored(data) {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(10 + blocks * 5 + data.length + 8); let o = 0;
  out[o++] = 0x1f; out[o++] = 0x8b; out[o++] = 8; out.fill(0, o, o + 6); o += 6; out[o - 1] = 255;
  let pos = 0;
  for (let b = 0; b < blocks; b++) {
    const len = Math.min(65535, data.length - pos);
    out[o++] = (b === blocks - 1) ? 1 : 0;
    out[o++] = len & 255; out[o++] = (len >>> 8) & 255;
    const n = (~len) & 0xFFFF; out[o++] = n & 255; out[o++] = (n >>> 8) & 255;
    out.set(data.subarray(pos, pos + len), o); o += len; pos += len;
  }
  const c = crc32(data);
  out[o++] = c & 255; out[o++] = (c >>> 8) & 255; out[o++] = (c >>> 16) & 255; out[o++] = (c >>> 24) & 255;
  const sz = data.length >>> 0;
  out[o++] = sz & 255; out[o++] = (sz >>> 8) & 255; out[o++] = (sz >>> 16) & 255; out[o++] = (sz >>> 24) & 255;
  return out.subarray(0, o);
}
/* minimal inflate, only what gzip from Litematica produces */
function inflateGzip(src) {
  let p = 10;
  const flg = src[3];
  if (flg & 4) { p += 2 + (src[p] | (src[p + 1] << 8)); }
  if (flg & 8) { while (src[p]) p++; p++; }
  if (flg & 16) { while (src[p]) p++; p++; }
  if (flg & 2) p += 2;
  return inflateRaw(src, p);
}
function inflateRaw(src, p) {
  let bitPos = 0, out = new Uint8Array(1 << 20), outLen = 0;
  const grow = n => { if (outLen + n <= out.length) return; let L = out.length; while (L < outLen + n) L *= 2; const t = new Uint8Array(L); t.set(out.subarray(0, outLen)); out = t; };
  const bit = () => { const b = (src[p] >> bitPos) & 1; if (++bitPos === 8) { bitPos = 0; p++; } return b; };
  const bits = n => { let v = 0; for (let i = 0; i < n; i++) v |= bit() << i; return v; };
  const build = lens => {
    const maxBits = Math.max(...lens);
    const blCount = new Array(maxBits + 1).fill(0);
    for (const l of lens) if (l) blCount[l]++;
    const next = new Array(maxBits + 1).fill(0);
    let code = 0;
    for (let b = 1; b <= maxBits; b++) { code = (code + blCount[b - 1]) << 1; next[b] = code; }
    const map = new Map();
    for (let i = 0; i < lens.length; i++) if (lens[i]) map.set(lens[i] + ':' + (next[lens[i]]++), i);
    return { map, maxBits };
  };
  const decode = t => { let code = 0; for (let l = 1; l <= t.maxBits; l++) { code = (code << 1) | bit(); const s = t.map.get(l + ':' + code); if (s !== undefined) return s; } throw new Error('bad huffman'); };
  const LB = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const LE = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const DB = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  const DE = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  for (;;) {
    const last = bit(), type = bits(2);
    if (type === 0) {
      if (bitPos) { bitPos = 0; p++; }
      const len = src[p] | (src[p + 1] << 8); p += 4;
      grow(len); out.set(src.subarray(p, p + len), outLen); outLen += len; p += len;
    } else {
      let lt, dt;
      if (type === 1) {
        const l = new Array(288); for (let i = 0; i < 144; i++) l[i] = 8; for (let i = 144; i < 256; i++) l[i] = 9; for (let i = 256; i < 280; i++) l[i] = 7; for (let i = 280; i < 288; i++) l[i] = 8;
        lt = build(l); dt = build(new Array(30).fill(5));
      } else {
        const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
        const ord = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
        const cl = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) cl[ord[i]] = bits(3);
        const ct = build(cl);
        const all = [];
        while (all.length < hlit + hdist) {
          const s = decode(ct);
          if (s < 16) all.push(s);
          else if (s === 16) { const r = 3 + bits(2), v = all[all.length - 1]; for (let i = 0; i < r; i++) all.push(v); }
          else if (s === 17) { const r = 3 + bits(3); for (let i = 0; i < r; i++) all.push(0); }
          else { const r = 11 + bits(7); for (let i = 0; i < r; i++) all.push(0); }
        }
        lt = build(all.slice(0, hlit)); dt = build(all.slice(hlit));
      }
      for (;;) {
        const s = decode(lt);
        if (s === 256) break;
        if (s < 256) { grow(1); out[outLen++] = s; }
        else {
          const li = s - 257, len = LB[li] + bits(LE[li]);
          const ds = decode(dt), dist = DB[ds] + bits(DE[ds]);
          grow(len);
          let from = outLen - dist;
          for (let i = 0; i < len; i++) out[outLen++] = out[from++];
        }
      }
    }
    if (last) break;
  }
  return out.subarray(0, outLen);
}

/* ---------------------------------------------------------------- block states */
export function stateName(entry) {
  let n = entry.Name;
  if (entry.Properties) {
    const keys = Object.keys(entry.Properties).sort();
    if (keys.length) n += '[' + keys.map(k => k + '=' + entry.Properties[k]).join(',') + ']';
  }
  return n;
}
export function splitState(name) {
  const i = name.indexOf('[');
  if (i < 0) return { id: name, props: null };
  const props = {};
  for (const kv of name.slice(i + 1, -1).split(',')) { const [k, v] = kv.split('='); props[k] = v; }
  return { id: name.slice(0, i), props };
}
function bitsFor(n) { return Math.max(2, 32 - Math.clz32(Math.max(1, n - 1))); }

function unpack(longs, bits, count, out) {
  const mask = bits >= 32 ? 0xFFFFFFFF : ((1 << bits) - 1) >>> 0;
  for (let i = 0; i < count; i++) {
    const start = i * bits, li = (start / 64) | 0, off = start - li * 64;
    const hi = longs.hi[li], lo = longs.lo[li];
    let v;
    if (off < 32) { v = lo >>> off; if (off + bits > 32) v |= hi << (32 - off); }
    else v = hi >>> (off - 32);
    v &= mask;
    if (off + bits > 64) v |= (longs.lo[li + 1] << (64 - off)) & mask;
    out[i] = v >>> 0;
  }
}
function pack(indices, bits) {
  const n = Math.ceil(indices.length * bits / 64);
  const hi = new Int32Array(n), lo = new Uint32Array(n);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] >>> 0, start = i * bits, li = (start / 64) | 0, off = start - li * 64;
    if (off < 32) {
      lo[li] |= (v << off) >>> 0;
      if (off + bits > 32) hi[li] |= v >>> (32 - off);
    } else hi[li] |= (v << (off - 32)) >>> 0;
    if (off + bits > 64) lo[li + 1] |= v >>> (64 - off);
  }
  const pairs = new Array(n);
  for (let i = 0; i < n; i++) pairs[i] = [hi[i] | 0, lo[i] >>> 0];
  return pairs;
}

/* ---------------------------------------------------------------- public */
export async function readLitematic(arrayBuffer) {
  const nbtBytes = await gunzip(new Uint8Array(arrayBuffer));
  const root = parseNBT(nbtBytes.buffer.slice(nbtBytes.byteOffset, nbtBytes.byteOffset + nbtBytes.byteLength));
  const regions = root.Regions || {};
  const names = Object.keys(regions);
  if (!names.length) throw new Error('This file has no regions in it.');

  const out = [];
  for (const rn of names) {
    const reg = regions[rn];
    const W = Math.abs(reg.Size.x), H = Math.abs(reg.Size.y), L = Math.abs(reg.Size.z);
    const palette = reg.BlockStatePalette.map(stateName);
    const count = W * H * L;
    const bits = bitsFor(palette.length);
    const Arr = palette.length <= 256 ? Uint8Array : palette.length <= 65536 ? Uint16Array : Uint32Array;
    const states = new Arr(count);
    unpack(reg.BlockStates, bits, count, states);
    out.push({ name: rn, W, H, L, palette, states, pos: reg.Position ? { x: reg.Position.x, y: reg.Position.y, z: reg.Position.z } : { x: 0, y: 0, z: 0 } });
  }
  const meta = root.Metadata || {};
  return {
    name: meta.Name || names[0], author: meta.Author || '', description: meta.Description || '',
    dataVersion: root.MinecraftDataVersion || 3955,
    regions: out
  };
}

/* states is index-into-palette, ordered y*W*L + z*W + x (Litematica's own order) */
export async function writeLitematic({ name, author, W, H, L, palette, states, dataVersion = 3955 }) {
  // drop palette entries nothing uses, so the file stays small and the bit width low
  const used = new Map();
  const remap = new Int32Array(palette.length).fill(-1);
  const airIdx = palette.indexOf(AIR);
  const compact = [];
  const pushPal = nm => { let i = used.get(nm); if (i === undefined) { i = compact.length; used.set(nm, i); compact.push(nm); } return i; };
  pushPal(AIR);                                      // Litematica expects air at 0
  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    if (remap[s] < 0) remap[s] = pushPal(palette[s]);
  }
  void airIdx;
  const bits = bitsFor(compact.length);
  const idx = new Uint32Array(states.length);
  let nonAir = 0;
  for (let i = 0; i < states.length; i++) { const v = remap[states[i]]; idx[i] = v; if (v !== 0) nonAir++; }

  const palItems = compact.map(nm => {
    const { id, props } = splitState(nm);
    const o = { Name: Str(id) };
    if (props) { const pc = {}; for (const k of Object.keys(props)) pc[k] = Str(props[k]); o.Properties = Comp(pc); }
    return Comp(o);
  });

  const now = Date.now();
  const region = {
    Position: Comp({ x: I(0), y: I(0), z: I(0) }),
    Size: Comp({ x: I(W), y: I(H), z: I(L) }),
    BlockStatePalette: List(10, palItems),
    BlockStates: LongArr(pack(idx, bits)),
    Entities: List(10, []),
    TileEntities: List(10, []),
    PendingBlockTicks: List(10, []),
    PendingFluidTicks: List(10, [])
  };
  const root = {
    MinecraftDataVersion: I(dataVersion),
    Version: I(6),
    Metadata: Comp({
      Name: Str(name || 'Build'), Author: Str(author || 'Elsazon'), Description: Str(''),
      TimeCreated: Long(now), TimeModified: Long(now),
      EnclosingSize: Comp({ x: I(W), y: I(H), z: I(L) }),
      TotalVolume: I(W * H * L), TotalBlocks: I(nonAir), RegionCount: I(1)
    }),
    Regions: Comp({ [name || 'Build']: Comp(region) })
  };
  const nbt = writeNBT(root);
  return { bytes: await gzip(nbt), nonAir, palette: compact.length };
}

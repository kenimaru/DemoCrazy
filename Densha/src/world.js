// Chunked world streaming: terrain strips, track, catenary, structures and scenery.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RNG, hashInts, clamp } from './util.js';
import { stationBoardTexture, buildingSignTexture, signTexture, prismGeo, canvasTex } from './assets.js';

export const CHUNK = 250;
const EDGE = [0, 2.2, 4.6, 8, 12.5, 18, 25, 34, 46, 62, 84, 115, 160, 225, 320, 460, 660, 950, 1400, 2200, 4000];

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

class Batch {
  constructor(geo, mat, { shadow = false, receive = false } = {}) {
    this.geo = geo;
    this.mat = mat;
    this.mats = [];
    this.cols = [];
    this.shadow = shadow;
    this.receive = receive;
  }
  add(x, y, z, yaw, sx, sy, sz, color, pitch = 0) {
    _e.set(0, yaw, pitch, 'YZX');
    _q.setFromEuler(_e);
    _p.set(x, y, z);
    _s.set(sx, sy, sz);
    this.mats.push(new THREE.Matrix4().compose(_p, _q, _s));
    this.cols.push(color);
  }
  addMatrix(m, color) {
    this.mats.push(m.clone());
    this.cols.push(color);
  }
  build(group, list) {
    const n = this.mats.length;
    if (!n) return null;
    const im = new THREE.InstancedMesh(this.geo, this.mat, n);
    const anyCol = this.cols.some((c) => c !== undefined && c !== null);
    for (let i = 0; i < n; i++) {
      im.setMatrixAt(i, this.mats[i]);
      if (anyCol) im.setColorAt(i, _c.set(this.cols[i] ?? 0xffffff));
    }
    im.castShadow = this.shadow;
    im.receiveShadow = this.receive;
    im.computeBoundingSphere();
    group.add(im);
    list.push(im);
    return im;
  }
}

function glowTexture() {
  return canvasTex(64, 64, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  }, { key: 'glow' });
}

const LAMP_COLORS = [0xffc21a, 0x19ff6a, 0xff2a1a, 0xffc21a]; // Y1, G, R, Y2
const ASPECT_LAMPS = [[2], [3], [0, 1], [1]]; // R, Y, YG, G

const FACADE = [0xe8e2d4, 0xd9d4cc, 0xc9b8a0, 0xb8c4c8, 0xe0c8c0, 0xd0d8c0, 0xf0efe8, 0xa8a298, 0xd8cfb8, 0xc0c8d8];
const SHED = [0x3a6ea5, 0x4f86b8, 0xc0582a, 0xd8d8d0, 0x5a9a7a, 0x3a6ea5];
const CARS = [0xf2f2f2, 0xbfc3c7, 0x222222, 0xa01818, 0x1d3f7a, 0x8a8f94, 0xf2f2f2];
const CLOTHES = [0x2d3b55, 0xd8d8d8, 0x9b2c2c, 0x333333, 0x486e4b, 0xc9a86a, 0x6b4f8f, 0xe0e0e0, 0x1f5f8b];

export class World {
  constructor(scene, route, terrain, assets) {
    this.scene = scene;
    this.r = route;
    this.t = terrain;
    this.A = assets;
    this.chunks = new Map();
    this.signals = new Map();
    this.crossings = new Map();
    this.rotors = new Set();
    this.tmp = {};
    this.tmp2 = {};
    this.col = {};
    this.signMats = new Map();
    this.glowTex = glowTexture();
    this.kMin = Math.floor(-600 / CHUNK);
    this.kMax = Math.floor((route.L + 1500) / CHUNK);
  }

  // ---------------- streaming ----------------
  // Incremental: advances one build stage per call (chunks are built across several frames).
  update(sBack, sFront, sFocus, steps = 1) {
    const k0 = Math.max(this.kMin, Math.floor(sBack / CHUNK));
    const k1 = Math.min(this.kMax, Math.floor(sFront / CHUNK));
    const kf = clamp(Math.floor(sFocus / CHUNK), k0, k1);
    for (let i = 0; i < steps; i++) {
      if (!this.gen) {
        let next = null;
        for (let k = kf; k <= k1 && next === null; k++) if (!this.chunks.has(k)) next = k;
        for (let k = kf - 1; k >= k0 && next === null; k--) if (!this.chunks.has(k)) next = k;
        if (next === null) break;
        this.gen = this.chunkGen(next);
      }
      if (this.gen.next().done) this.gen = null;
    }
    for (const [k, ch] of this.chunks) {
      if (!ch.building && (k < k0 - 1 || k > k1 + 1)) this.disposeChunk(k, ch);
    }
  }

  isReady(sBack, sFront) {
    const k0 = Math.max(this.kMin, Math.floor(sBack / CHUNK));
    const k1 = Math.min(this.kMax, Math.floor(sFront / CHUNK));
    for (let k = k0; k <= k1; k++) {
      const ch = this.chunks.get(k);
      if (!ch || ch.building) return false;
    }
    return true;
  }

  pendingCount(sBack, sFront) {
    const k0 = Math.max(this.kMin, Math.floor(sBack / CHUNK));
    const k1 = Math.min(this.kMax, Math.floor(sFront / CHUNK));
    let n = 0;
    for (let k = k0; k <= k1; k++) if (!this.chunks.has(k) || this.chunks.get(k).building) n++;
    return n;
  }

  disposeChunk(k, ch) {
    this.scene.remove(ch.group);
    for (const g of ch.own) g.dispose();
    for (const im of ch.inst) im.dispose();
    for (const id of ch.signals) this.signals.delete(id);
    for (const id of ch.crossings) this.crossings.delete(id);
    for (const r of ch.rotors) this.rotors.delete(r);
    this.chunks.delete(k);
  }

  disposeAll() {
    this.gen = null;
    for (const [k, ch] of [...this.chunks]) this.disposeChunk(k, ch);
  }

  // local position (relative to chunk origin) of track coords
  loc(ctx, s, d, yAbs, out = _p) {
    const f = this.r.frame(s, d, this.tmp);
    out.set(f.x - ctx.O.x, (yAbs === undefined ? f.y : yAbs) - ctx.O.y, f.z - ctx.O.z);
    return out;
  }

  buildChunk(k) {
    const g = this.chunkGen(k);
    while (!g.next().done);
  }

  *chunkGen(k) {
    const r = this.r;
    const c0 = k * CHUNK, c1 = c0 + CHUNK;
    const Of = r.frame(c0, 0, {});
    const O = { x: Of.x, y: Of.y, z: Of.z };
    const group = new THREE.Group();
    group.position.set(O.x, O.y, O.z);
    const ctx = {
      k, c0, c1, O, group, rng: new RNG(hashInts(r.seed, k, 12345)),
      own: [], inst: [], signals: [], crossings: [], rotors: [],
    };
    ctx.building = true;
    this.chunks.set(k, ctx);
    this.buildTerrain(ctx);
    yield;
    this.buildTrack(ctx);
    this.buildCatenary(ctx);
    this.buildTunnels(ctx);
    this.buildBridges(ctx);
    yield;
    this.buildStations(ctx);
    this.buildSignals(ctx);
    this.buildSigns(ctx);
    this.buildCrossings(ctx);
    yield;
    this.buildScenery(ctx);
    this.scene.add(group);
    ctx.building = false;
  }

  mesh(ctx, geo, mat, { shadow = false, receive = false } = {}) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow;
    m.receiveShadow = receive;
    ctx.group.add(m);
    ctx.own.push(geo);
    return m;
  }

  // ---------------- terrain ----------------
  buildTerrain(ctx) {
    const r = this.r, T = this.t;
    const rows = [];
    for (let s = ctx.c0; s <= ctx.c1 + 1e-6; s += 5) rows.push({ s, brk: false });
    for (const t of r.tunnels) {
      for (const p of [t.a, t.b]) {
        if (p > ctx.c0 + 0.1 && p < ctx.c1 - 0.1) {
          rows.push({ s: p - 0.03, brk: true });
          rows.push({ s: p + 0.03, brk: false });
        }
      }
    }
    rows.sort((a, b) => a.s - b.s);
    // remove rows too close to break rows (avoid slivers)
    const clean = [];
    for (const row of rows) {
      const prev = clean[clean.length - 1];
      if (prev && row.s - prev.s < 0.5 && !prev.brk && !row.brk && Math.abs(row.s - Math.round(row.s)) < 1e-6 && clean.length > 1) continue;
      clean.push(row);
    }
    const nc = EDGE.length * 2 + 1;
    const nr = clean.length;
    const pos = new Float32Array(nr * nc * 3);
    const col = new Float32Array(nr * nc * 3);
    const uv = new Float32Array(nr * nc * 2);
    const out = this.col;
    const f = this.tmp;
    let vi = 0;
    for (const row of clean) {
      const s = row.s;
      const [bL, bR] = r.bedAt(s);
      const lim = r.sideLimit(s);
      const ds = [];
      for (let i = EDGE.length - 1; i >= 0; i--) ds.push(bL - EDGE[i]);
      ds.push((bL + bR) / 2);
      for (let i = 0; i < EDGE.length; i++) ds.push(bR + EDGE[i]);
      for (let d of ds) {
        if (d < -lim[0]) d = -lim[0];
        if (d > lim[1]) d = lim[1];
        const h = T.height(s, d, out);
        r.frame(s, d, f);
        pos[vi * 3] = f.x - ctx.O.x;
        pos[vi * 3 + 1] = h - ctx.O.y;
        pos[vi * 3 + 2] = f.z - ctx.O.z;
        col[vi * 3] = out.r;
        col[vi * 3 + 1] = out.g;
        col[vi * 3 + 2] = out.b;
        uv[vi * 2] = f.x * 0.11;
        uv[vi * 2 + 1] = f.z * 0.11;
        vi++;
      }
    }
    const idx = [];
    for (let i = 0; i < nr - 1; i++) {
      if (clean[i].brk) continue;
      for (let j = 0; j < nc - 1; j++) {
        const a = i * nc + j, b = a + 1, c = a + nc, d = c + 1;
        idx.push(a, b, c, c, b, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.mesh(ctx, g, this.A.mat.terrain, { receive: true });
  }

  // Extrude cross-section segments along the track. segs: [{a:[d,dy], b:[d,dy], c:[r,g,b]}]
  extrude(ctx, segs, s0, s1, step, { uScale = 0.5, vScale = 0.5, colors = false } = {}) {
    const r = this.r;
    const ss = [];
    for (let s = s0; s < s1 - 1e-3; s += step) ss.push(s);
    ss.push(s1);
    const pos = [], uv = [], col = [], idx = [];
    const f = this.tmp;
    let base = 0;
    for (const sg of segs) {
      const len = Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]);
      for (const s of ss) {
        r.frame(s, 0, f);
        const sn = Math.sin(f.h), cs = Math.cos(f.h);
        for (const [pt, u] of [[sg.a, 0], [sg.b, len]]) {
          pos.push(f.x - sn * pt[0] - ctx.O.x, f.y + pt[1] - ctx.O.y, f.z + cs * pt[0] - ctx.O.z);
          uv.push((sg.u0 || 0) + u * uScale, s * vScale);
          if (colors) col.push(...(sg.c || [1, 1, 1]));
        }
      }
      for (let i = 0; i < ss.length - 1; i++) {
        const a = base + i * 2, b = a + 1, a2 = a + 2, b2 = a + 3;
        idx.push(a, b, a2, b, b2, a2);
      }
      base += ss.length * 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    if (colors) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  // ---------------- track ----------------
  buildTrack(ctx) {
    const r = this.r, A = this.A;
    const c0 = ctx.c0, c1 = ctx.c1;
    if (c1 < -200 || c0 > r.L + 1200) return;
    const tr = r.tracks;
    const dl = tr[0] - 1.95, dr = tr[tr.length - 1] + 1.95;
    const ballastSegs = [
      { a: [dl, -0.75], b: [dl + 0.6, -0.25] },
      { a: [dl + 0.6, -0.25], b: [dr - 0.6, -0.25], u0: 0.3 },
      { a: [dr - 0.6, -0.25], b: [dr, -0.75] },
    ];
    this.mesh(ctx, this.extrude(ctx, ballastSegs, c0, c1, 2.5), A.mat.ballast, { receive: true });

    // rails
    const railSegs = [];
    const top = [0.78, 0.76, 0.72], side = [0.19, 0.15, 0.12];
    for (const d0 of tr) {
      for (const rd of [d0 - 0.568, d0 + 0.568]) {
        railSegs.push({ a: [rd - 0.034, -0.15], b: [rd - 0.034, 0], c: side });
        railSegs.push({ a: [rd - 0.034, 0], b: [rd + 0.034, 0], c: top });
        railSegs.push({ a: [rd + 0.034, 0], b: [rd + 0.034, -0.15], c: side });
      }
    }
    this.mesh(ctx, this.extrude(ctx, railSegs, c0, c1, 2.5, { colors: true }), A.mat.rail);

    // sleepers
    const sb = new Batch(A.geo.sleeper, A.mat.sleeper, { receive: true });
    const f = this.tmp;
    for (const d0 of tr) {
      for (let s = Math.ceil(c0 / 0.6) * 0.6; s < c1; s += 0.6) {
        r.frame(s, d0, f);
        sb.add(f.x - ctx.O.x, f.y - 0.24 - ctx.O.y, f.z - ctx.O.z, -f.h, 1, 1, 1);
      }
    }
    sb.build(ctx.group, ctx.inst);
  }

  buildCatenary(ctx) {
    const r = this.r, A = this.A;
    const c0 = ctx.c0, c1 = ctx.c1;
    if (c1 < -200 || c0 > r.L + 1200) return;
    const SP = 45;
    const L = new Batch(A.mastL, A.mat.steel, { shadow: true });
    const R = new Batch(A.mastR, A.mat.steel, { shadow: true });
    const f = this.tmp;
    const pts = [];
    const firstM = Math.ceil(c0 / SP);
    const lastM = Math.floor(c1 / SP) + 1;
    for (let m = firstM - 0; m <= lastM; m++) {
      const s = m * SP;
      const inT = r.tunnelAt(s);
      if (s < c1 && s >= c0 && !inT) {
        r.frame(s, -3.3, f);
        L.add(f.x - ctx.O.x, f.y - 0.75 - ctx.O.y, f.z - ctx.O.z, -f.h, 1, 1, 1);
        if (r.double) {
          r.frame(s, 7.3, f);
          R.add(f.x - ctx.O.x, f.y - 0.75 - ctx.O.y, f.z - ctx.O.z, -f.h, 1, 1, 1);
        }
      }
      pts.push({ s, m });
    }
    // include previous mast so wires start at chunk boundary
    pts.unshift({ s: (firstM - 1) * SP, m: firstM - 1 });
    L.build(ctx.group, ctx.inst);
    R.build(ctx.group, ctx.inst);
    const lp = [];
    for (const d0 of r.tracks) {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if (a.s >= c1 || b.s <= c0) continue;
        const za = (a.m % 2 ? 0.2 : -0.2), zb = (b.m % 2 ? 0.2 : -0.2);
        r.frame(a.s, d0 + za, f);
        const ax = f.x - ctx.O.x, ay = f.y - ctx.O.y, az = f.z - ctx.O.z;
        r.frame(b.s, d0 + zb, f);
        const bx = f.x - ctx.O.x, by = f.y - ctx.O.y, bz = f.z - ctx.O.z;
        lp.push(ax, ay + 5.3, az, bx, by + 5.3, bz);
        r.frame(a.s, d0, f);
        const mx0 = f.x - ctx.O.x, my0 = f.y - ctx.O.y, mz0 = f.z - ctx.O.z;
        r.frame((a.s + b.s) / 2, d0, f);
        const mx = f.x - ctx.O.x, my = f.y - ctx.O.y, mz = f.z - ctx.O.z;
        r.frame(b.s, d0, f);
        const mx1 = f.x - ctx.O.x, my1 = f.y - ctx.O.y, mz1 = f.z - ctx.O.z;
        lp.push(mx0, my0 + 6.5, mz0, mx, my + 6.15, mz, mx, my + 6.15, mz, mx1, my1 + 6.5, mz1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    const lines = new THREE.LineSegments(g, A.mat.wire);
    ctx.group.add(lines);
    ctx.own.push(g);

    // urban noise walls
    const W = new Batch(A.wallGeo, A.mat.concrete, { receive: true });
    for (let s = Math.ceil(c0 / 5) * 5; s < c1; s += 5) {
      const p = this.t.params(s);
      if (p.wall < 0.3 || this.t.n1.noise(s * 0.004, 9.1) * 0.5 + 0.5 > p.wall) continue;
      if (r.stationAt(s, 20) || r.tunnelAt(s) || r.bridgeAt(s)) continue;
      if (r.crossings.some((c) => Math.abs(c.s - s) < 18)) continue;
      const [bL, bR] = r.bedAt(s);
      for (const d of [bL - 0.6, bR + 0.6]) {
        r.frame(s + 2.5, d, f);
        W.add(f.x - ctx.O.x, f.y - 0.8 - ctx.O.y, f.z - ctx.O.z, -f.h, 1, 1, 1);
      }
    }
    W.build(ctx.group, ctx.inst);
  }

  // ---------------- tunnels ----------------
  tunnelProfile() {
    const r = this.r;
    const hw = r.tunnelHW, sp = r.tunnelSpring, c = r.double ? 2 : 0;
    const pts = [[c + hw, -0.75], [c + hw, sp]];
    const N = 14;
    for (let i = 1; i < N; i++) {
      const a = (i / N) * Math.PI;
      pts.push([c + Math.cos(a) * hw, sp + Math.sin(a) * hw]);
    }
    pts.push([c - hw, sp], [c - hw, -0.75], [c + hw, -0.75]);
    return pts;
  }

  buildTunnels(ctx) {
    const r = this.r, A = this.A;
    const prof = this.tunnelProfile();
    const segs = [];
    let u = 0;
    for (let i = 0; i < prof.length - 1; i++) {
      const a = prof[i], b = prof[i + 1];
      segs.push({ a, b, u0: u });
      u += Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.12;
    }
    const f = this.tmp;
    for (const t of r.tunnels) {
      const s0 = Math.max(t.a, ctx.c0), s1 = Math.min(t.b, ctx.c1);
      if (s1 - s0 < 0.05) continue;
      this.mesh(ctx, this.extrude(ctx, segs, s0, s1, 5, { uScale: 1, vScale: 0.1 }), A.mat.tunnel);
      const lamps = new Batch(A.geo.unitBox, A.mat.tunnelLamp);
      const c = r.double ? 2 : 0;
      for (let s = Math.ceil(s0 / 25) * 25; s < s1; s += 25) {
        r.frame(s, c - r.tunnelHW + 0.12, f);
        lamps.add(f.x - ctx.O.x, f.y + 2.6 - ctx.O.y, f.z - ctx.O.z, -f.h, 0.9, 0.12, 0.12);
      }
      lamps.build(ctx.group, ctx.inst);
      if (t.a > ctx.c0 && t.a <= ctx.c1) this.buildPortal(ctx, t.a - 0.03, t.a + 0.03);
      if (t.b > ctx.c0 && t.b <= ctx.c1) this.buildPortal(ctx, t.b + 0.03, t.b - 0.03);
    }
  }

  buildPortal(ctx, sOut, sIn) {
    const r = this.r, T = this.t;
    const s0 = (sOut + sIn) / 2;
    const y = r.yAt(s0);
    const c = r.double ? 2 : 0, hw = r.tunnelHW, sp = r.tunnelSpring;
    const ds = [];
    for (let u = -70; u <= 70; u += 2.5) if (Math.abs(u) > hw + 0.05) ds.push(c + u);
    ds.push(c - hw - 0.02, c + hw + 0.02);
    for (let i = 0; i <= 16; i++) ds.push(c - hw + (2 * hw * i) / 16);
    ds.sort((a, b) => a - b);
    const lo = [], up = [];
    for (const d of ds) {
      let l = T.height(sOut, d);
      const u = T.height(sIn, d);
      const du = Math.abs(d - c);
      if (du <= hw) l = Math.max(l, y + sp + Math.sqrt(Math.max(0, hw * hw - du * du)));
      lo.push(l);
      up.push(Math.max(u, l));
    }
    // split each column at the top of the concrete portal face; above it the face is hillside
    const faceTop = y + sp + hw + 2.2;
    const faceW = hw + 2.5;
    const pos = [], col = [];
    const f = this.tmp;
    const conc = [0.36, 0.35, 0.32], hill = [0.05, 0.11, 0.04];
    const quad = (i, y0a, y1a, y0b, y1b, c) => {
      r.frame(s0, ds[i], f);
      const ax = f.x - ctx.O.x, az = f.z - ctx.O.z;
      r.frame(s0, ds[i + 1], f);
      const bx = f.x - ctx.O.x, bz = f.z - ctx.O.z;
      const oy = ctx.O.y;
      pos.push(ax, y0a - oy, az, bx, y0b - oy, bz, bx, y1b - oy, bz);
      pos.push(ax, y0a - oy, az, bx, y1b - oy, bz, ax, y1a - oy, az);
      for (let k = 0; k < 6; k++) col.push(...c);
    };
    for (let i = 0; i < ds.length - 1; i++) {
      if (up[i] - lo[i] < 0.01 && up[i + 1] - lo[i + 1] < 0.01) continue;
      const inFace = Math.abs(ds[i] - c) <= faceW && Math.abs(ds[i + 1] - c) <= faceW;
      if (inFace) {
        const ma = clamp(faceTop, lo[i], up[i]), mb = clamp(faceTop, lo[i + 1], up[i + 1]);
        quad(i, lo[i], ma, lo[i + 1], mb, conc);
        quad(i, ma, up[i], mb, up[i + 1], hill);
      } else {
        quad(i, lo[i], up[i], lo[i + 1], up[i + 1], hill);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const mat = this.portalMat || (this.portalMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    this.mesh(ctx, g, mat, { receive: true });
  }

  // ---------------- bridges ----------------
  buildBridges(ctx) {
    const r = this.r, A = this.A, T = this.t;
    const dL = -3.4, dR = r.double ? 7.4 : 3.4;
    const c = (dL + dR) / 2;
    const f = this.tmp;
    for (const b of r.bridges) {
      const s0 = Math.max(b.a, ctx.c0), s1 = Math.min(b.b, ctx.c1);
      if (s1 - s0 < 0.05) continue;
      const segs = [
        { a: [dL, -0.75], b: [dR, -0.75] },
        { a: [dR, -0.75], b: [dR, -2.8] },
        { a: [dR, -2.8], b: [dL, -2.8] },
        { a: [dL, -2.8], b: [dL, -0.75] },
        { a: [dL, -0.75], b: [dL, 0.35] },
        { a: [dL, 0.35], b: [dL + 0.22, 0.35] },
        { a: [dL + 0.22, 0.35], b: [dL + 0.22, -0.75] },
        { a: [dR - 0.22, -0.75], b: [dR - 0.22, 0.35] },
        { a: [dR - 0.22, 0.35], b: [dR, 0.35] },
        { a: [dR, 0.35], b: [dR, -0.75] },
      ];
      this.mesh(ctx, this.extrude(ctx, segs, s0, s1, 5, { uScale: 0.25, vScale: 0.25 }), A.mat.concrete, { shadow: true, receive: true });
      // piers
      const P = new Batch(A.geo.unitBoxBase, A.mat.concrete, { shadow: true });
      const n = Math.max(1, Math.round((b.b - b.a - 20) / b.span));
      const sp = (b.b - b.a - 20) / n;
      for (let i = 1; i < n; i++) {
        const s = b.a + 10 + i * sp;
        if (s < ctx.c0 || s >= ctx.c1) continue;
        const ground = T.height(s, c) - 1.5;
        const y = r.yAt(s);
        r.frame(s, c, f);
        const h = y - 2.8 - ground;
        if (h > 0.5) P.add(f.x - ctx.O.x, ground - ctx.O.y, f.z - ctx.O.z, -f.h + b.river.skew, 2.2, h, dR - dL - 1.2);
      }
      for (const e of [b.a + 3, b.b - 3]) {
        if (e < ctx.c0 || e >= ctx.c1) continue;
        const y = r.yAt(e);
        r.frame(e, c, f);
        P.add(f.x - ctx.O.x, y - 7 - ctx.O.y, f.z - ctx.O.z, -f.h, 7, 6.2, dR - dL + 0.6);
      }
      P.build(ctx.group, ctx.inst);
      if (b.truss) this.buildTruss(ctx, b, s0, s1, dL, dR);
    }
  }

  buildTruss(ctx, b, s0, s1, dL, dR) {
    const r = this.r;
    const mat = this.trussMat || (this.trussMat = new THREE.MeshLambertMaterial({ color: 0x5f7a70 }));
    const B = new Batch(this.A.geo.unitBox, mat, { shadow: true });
    const f = this.tmp;
    const P = (s, d, dy) => {
      r.frame(s, d, f);
      return new THREE.Vector3(f.x - ctx.O.x, f.y + dy - ctx.O.y, f.z - ctx.O.z);
    };
    const beamM = (a, bb, t) => {
      const len = a.distanceTo(bb);
      const dir = bb.clone().sub(a).normalize();
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(a.clone().add(bb).multiplyScalar(0.5), _q, _s.set(len, t, t));
      B.addMatrix(_m);
    };
    const H = 6.8, step = 5;
    const start = b.a + 6;
    const k0 = Math.ceil((s0 - start) / step), k1 = Math.floor((s1 - start) / step);
    for (const d of [dL - 0.25, dR + 0.25]) {
      for (let k = k0; k <= k1; k++) {
        const s = start + k * step;
        if (s > b.b - 6 || s < start) continue;
        const sN = s + step;
        beamM(P(s, d, H), P(s, d, -0.9), 0.3);
        if (sN <= b.b - 6) {
          beamM(P(s, d, H), P(sN, d, H), 0.45);
          beamM(P(s, d, -0.9), P(sN, d, -0.9), 0.45);
          if (k % 2) beamM(P(s, d, H), P(sN, d, -0.9), 0.26);
          else beamM(P(s, d, -0.9), P(sN, d, H), 0.26);
        }
      }
    }
    for (let k = k0; k <= k1; k++) {
      const s = start + k * step;
      if (s > b.b - 6 || s < start || k % 2) continue;
      beamM(P(s, dL - 0.25, H), P(s, dR + 0.25, H), 0.25);
    }
    B.build(ctx.group, ctx.inst);
  }

  // ---------------- stations ----------------
  buildStations(ctx) {
    for (const st of this.r.stations) {
      if (st.center >= ctx.c0 && st.center < ctx.c1) this.buildStation(ctx, st);
    }
  }

  buildStation(ctx, st) {
    const r = this.r, A = this.A;
    const f = r.frame(st.center, 0, {});
    const g = new THREE.Group();
    g.position.set(f.x - ctx.O.x, f.y - ctx.O.y, f.z - ctx.O.z);
    g.rotation.y = -f.h;
    ctx.group.add(g);
    const add = (geo, mat, x, y, z, opts = {}) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = !!opts.shadow;
      m.receiveShadow = opts.receive !== false;
      g.add(m);
      ctx.own.push(geo);
      return m;
    };
    const len = st.platLen;
    const PT = 1.1;
    const sides = [{ z: -4.62, e: -1.0 }];
    if (r.double) sides.push({ z: 8.62, e: 1.0 });
    const canLen = len * 0.55;
    const canX = st.s - 60 - canLen / 2 - st.center;
    for (const sd of sides) {
      add(new THREE.BoxGeometry(len, 1.85, 6), A.mat.platform, 0, PT - 0.925, sd.z);
      const edgeZ = sd.z - sd.e * 2.9;
      add(new THREE.BoxGeometry(len, 0.02, 0.14), A.mat.white, 0, PT + 0.01, edgeZ);
      add(new THREE.BoxGeometry(len, 0.02, 0.32), A.mat.yellow, 0, PT + 0.01, edgeZ + sd.e * 0.62);
      // canopy
      add(new THREE.BoxGeometry(canLen, 0.22, 6.8), A.mat.canopy, canX, PT + 3.75, sd.z - 0.2 * sd.e, { shadow: true, receive: false });
      add(new THREE.BoxGeometry(canLen, 0.06, 0.4), A.mat.lampWarm, canX, PT + 3.6, sd.z, { receive: false });
      const cols = new Batch(A.geo.cyl, A.mat.steel, { shadow: true });
      for (let x = canX - canLen / 2 + 4; x < canX + canLen / 2; x += 11) cols.add(x, PT, sd.z + sd.e * 1.1, 0, 0.24, 3.7, 0.24);
      const cim = cols.build(g, ctx.inst);
      // name boards
      const tex = stationBoardTexture(st);
      const bmat = this.boardMat(tex);
      for (const bx of [-len * 0.32, canX, len * 0.34]) {
        const b = add(new THREE.PlaneGeometry(3.3, 1.1), bmat, bx, PT + 2.35, sd.z + sd.e * 2.7, { receive: false });
        if (sd.e > 0) b.rotation.y = Math.PI;
        add(new THREE.BoxGeometry(0.08, 2.4, 0.08), A.mat.darkSteel, bx - 1.5, PT + 1.2, sd.z + sd.e * 2.75);
        add(new THREE.BoxGeometry(0.08, 2.4, 0.08), A.mat.darkSteel, bx + 1.5, PT + 1.2, sd.z + sd.e * 2.75);
      }
      // passengers
      const n = st.major ? 26 : 12;
      const rng = new RNG(hashInts(r.seed, st.idx, sd.e > 0 ? 7 : 3));
      const bodies = new Batch(A.personGeo, A.mat.person, { shadow: true });
      const heads = new Batch(A.headGeo, A.mat.head);
      for (let i = 0; i < n; i++) {
        const x = canX + rng.range(-canLen / 2, canLen / 2);
        const z = sd.z + rng.range(-1.6, 2.4) * -sd.e;
        const yaw = rng.range(-0.6, 0.6) + (sd.e < 0 ? Math.PI / 2 : -Math.PI / 2);
        const sc = rng.range(0.9, 1.08);
        bodies.add(x, PT, z, yaw, 1, sc, 1, rng.pick(CLOTHES));
        heads.add(x, PT + (sc - 1) * 1.4, z, yaw, 1, 1, 1);
      }
      bodies.build(g, ctx.inst);
      heads.build(g, ctx.inst);
    }
    // stop position marker for our train length
    const stopTex = signTexture('stop', r.train.cars);
    const mx = st.s - st.center + 4.5;
    const sm = add(new THREE.PlaneGeometry(0.7, 0.88), this.boardMat(stopTex), mx, PT + 2.3, -2.5, { receive: false });
    sm.rotation.y = -Math.PI / 2;
    add(new THREE.BoxGeometry(0.07, 2.0, 0.07), A.mat.darkSteel, mx + 0.03, PT + 1.0, -2.5);
    // station building
    const wooden = st.wooden;
    const bw = st.major ? 34 : 20, bd = st.major ? 14 : 10, bh = st.major ? 8 : 5;
    const bz = -22 - bd / 2 + 5;
    add(new THREE.BoxGeometry(bw, bh, bd), wooden ? A.mat.wood : A.mat.white, 0, -0.75 + bh / 2, bz, { shadow: true });
    const roofGeo = prismGeo(bd + 1.2, wooden ? 3.2 : 2.2, bw + 1.2).rotateY(Math.PI / 2);
    add(roofGeo, wooden ? A.mat.tileRoof : A.mat.canopy, 0, -0.75 + bh, bz, { shadow: true });
    const sign = add(new THREE.PlaneGeometry(bw * 0.5, bw * 0.125), this.boardMat(buildingSignTexture(st)), 0, -0.75 + bh * 0.72, bz + bd / 2 + 0.05, { receive: false });
    sign.rotation.y = 0;
    // footbridge at major stations
    if (st.major && r.double) {
      const fx = st.pStart + 45 - st.center;
      add(new THREE.BoxGeometry(3.2, 1.0, 20), A.mat.white, fx, PT + 6.6, 2, { shadow: true });
      add(new THREE.BoxGeometry(3.4, 2.4, 20), A.mat.glass, fx, PT + 8.2, 2, { receive: false });
      for (const z of [-5.4, 9.4]) add(new THREE.BoxGeometry(3.2, 6.4, 3.2), A.mat.white, fx, PT + 3.2, z, { shadow: true });
    }
  }

  boardMat(tex) {
    let m = this.signMats.get(tex.uuid);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide, transparent: false });
      this.signMats.set(tex.uuid, m);
    }
    return m;
  }

  // ---------------- signals & signs ----------------
  buildSignals(ctx) {
    const r = this.r, A = this.A;
    const f = this.tmp;
    for (const sig of r.signals) {
      if (sig.s < ctx.c0 || sig.s >= ctx.c1) continue;
      r.frame(sig.s, -3.0, f);
      const g = new THREE.Group();
      g.position.set(f.x - ctx.O.x, f.y - 0.75 - ctx.O.y, f.z - ctx.O.z);
      g.rotation.y = -f.h;
      const mast = new THREE.Mesh(A.geo.cyl, A.mat.steel);
      mast.scale.set(0.2, 5.6, 0.2);
      g.add(mast);
      const head = new THREE.Mesh(A.geo.unitBox, A.mat.signalHead);
      head.scale.set(0.2, 1.55, 0.52);
      head.position.set(0, 5.1, 0);
      g.add(head);
      const back = new THREE.Mesh(A.geo.unitBox, A.mat.signalHead);
      back.scale.set(0.05, 1.9, 0.9);
      back.position.set(0.1, 5.1, 0);
      g.add(back);
      const lamps = [], glows = [];
      const ys = [5.68, 5.3, 4.92, 4.54];
      for (let i = 0; i < 4; i++) {
        const lm = new THREE.Mesh(this.lampGeo || (this.lampGeo = new THREE.SphereGeometry(0.13, 10, 8)), new THREE.MeshBasicMaterial({ color: 0x151515 }));
        lm.position.set(-0.1, ys[i], 0);
        g.add(lm);
        lamps.push(lm);
        const gl = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: LAMP_COLORS[i], blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
        gl.scale.set(1.6, 1.6, 1);
        gl.position.set(-0.3, ys[i], 0);
        gl.visible = false;
        g.add(gl);
        glows.push(gl);
      }
      if (sig.type !== 'auto') {
        const plate = new THREE.Mesh(A.geo.unitBox, A.mat.white);
        plate.scale.set(0.05, 0.3, 0.5);
        plate.position.set(-0.08, 4.05, 0);
        g.add(plate);
      }
      ctx.group.add(g);
      const entry = { sig, lamps, glows, aspect: -1 };
      this.signals.set(sig.id, entry);
      ctx.signals.push(sig.id);
      if (this.aspectFn) this.setAspect(sig.id, this.aspectFn(sig));
    }
  }

  setAspect(id, level) {
    const e = this.signals.get(id);
    if (!e || e.aspect === level) return;
    e.aspect = level;
    const on = ASPECT_LAMPS[level];
    for (let i = 0; i < 4; i++) {
      const lit = on.includes(i);
      e.lamps[i].material.color.set(lit ? LAMP_COLORS[i] : 0x151515);
      e.glows[i].visible = lit;
    }
  }

  buildSigns(ctx) {
    const r = this.r, A = this.A;
    const f = this.tmp;
    const list = [...r.signs.map((s) => ({ s: s.s, kind: s.kind, v: s.v }))];
    for (const w of r.whistles) list.push({ s: w.s, kind: 'whistle', v: 0 });
    for (const sn of list) {
      if (sn.s < ctx.c0 || sn.s >= ctx.c1) continue;
      r.frame(sn.s, -2.8, f);
      const g = new THREE.Group();
      g.position.set(f.x - ctx.O.x, f.y - 0.75 - ctx.O.y, f.z - ctx.O.z);
      g.rotation.y = -f.h;
      const pole = new THREE.Mesh(A.geo.cyl, A.mat.steel);
      pole.scale.set(0.08, 2.6, 0.08);
      g.add(pole);
      const b = new THREE.Mesh(this.signPlane || (this.signPlane = new THREE.PlaneGeometry(0.64, 0.8)), this.boardMat(signTexture(sn.kind, sn.v)));
      b.rotation.y = -Math.PI / 2;
      b.position.set(-0.05, 2.75, 0);
      g.add(b);
      ctx.group.add(g);
    }
  }

  // ---------------- level crossings ----------------
  buildCrossings(ctx) {
    const r = this.r, A = this.A, T = this.t;
    const f = this.tmp;
    for (const c of r.crossings) {
      if (c.s < ctx.c0 || c.s >= ctx.c1) continue;
      const y = r.yAt(c.s);
      const hwS = 3.6 / Math.cos(c.skew);
      const lim = r.sideLimit(c.s);
      const [bL, bR] = r.bedAt(c.s);
      const pos = [], uv = [], idx = [];
      let n = 0;
      for (let d = -Math.min(140, lim[0] * 0.9); d <= Math.min(140, lim[1] * 0.9); d += 3) {
        const sc = c.s + d * c.tan;
        const dist = d < bL ? bL - d : d > bR ? d - bR : 0;
        for (const e of [-1, 1]) {
          const s = sc + e * hwS;
          const th = T.height(s, d);
          const h = Math.max(th + 0.08, y - 0.02 - dist * 0.09);
          r.frame(s, d, f);
          pos.push(f.x - ctx.O.x, h - ctx.O.y, f.z - ctx.O.z);
          uv.push(e < 0 ? 0 : 1, d / 8);
        }
        if (n > 0) {
          const a = (n - 1) * 2;
          idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
        n++;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const nrm = g.attributes.normal;
      for (let i = 0; i < nrm.count; i++) if (nrm.getY(i) < 0) nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i));
      if (!this.roadMat) this.roadMat = new THREE.MeshLambertMaterial({ map: A.road, side: THREE.DoubleSide });
      this.mesh(ctx, g, this.roadMat, { receive: true });

      // gates, lights, waiting traffic
      const pivots = [], lamps = [];
      const makeGate = (d, sEdge, dirS) => {
        r.frame(sEdge, d, f);
        const grp = new THREE.Group();
        grp.position.set(f.x - ctx.O.x, T.height(sEdge, d) - ctx.O.y, f.z - ctx.O.z);
        grp.rotation.y = -f.h;
        const post = new THREE.Mesh(A.geo.unitBoxBase, A.mat.white);
        post.scale.set(0.3, 1.2, 0.3);
        grp.add(post);
        const pv = new THREE.Group();
        pv.position.set(0, 1.0, 0);
        const arm = new THREE.Mesh(this.armGeo || (this.armGeo = new THREE.BoxGeometry(0.1, 6.8, 0.1).translate(0, 3.4, 0)), A.mat.stripe);
        arm.castShadow = true;
        pv.add(arm);
        pv.userData.dir = dirS;
        grp.add(pv);
        pivots.push(pv);
        // warning light post
        const lp = new THREE.Group();
        lp.position.set(-dirS * 0.9, 0, 0);
        const pole = new THREE.Mesh(A.geo.cyl, A.mat.white);
        pole.scale.set(0.12, 3.6, 0.12);
        lp.add(pole);
        const xb = new THREE.Mesh(this.xbGeo || (this.xbGeo = new THREE.PlaneGeometry(1.3, 1.6)), this.xbMat || (this.xbMat = new THREE.MeshLambertMaterial({ map: signTexture('crossing', 0), transparent: true, side: THREE.DoubleSide, alphaTest: 0.3 })));
        xb.position.set(0, 3.5, 0);
        xb.rotation.y = d < 0 ? Math.PI : 0;
        lp.add(xb);
        for (const lx of [-0.28, 0.28]) {
          const lm = new THREE.Mesh(this.xlGeo || (this.xlGeo = new THREE.SphereGeometry(0.13, 8, 6)), new THREE.MeshBasicMaterial({ color: 0x331111 }));
          lm.position.set(lx, 2.55, d < 0 ? -0.08 : 0.08);
          lp.add(lm);
          lamps.push(lm);
        }
        grp.add(lp);
        ctx.group.add(grp);
      };
      makeGate(bL - 3.2, c.s + (bL - 3.2) * c.tan + hwS + 0.4, -1);
      makeGate(bR + 3.2, c.s + (bR + 3.2) * c.tan - hwS - 0.4, 1);
      // waiting vehicles
      const rng = ctx.rng;
      const cars = new Batch(this.carGeo || (this.carGeo = this.makeCarGeo()), A.mat.car, { shadow: true });
      const scoot = new Batch(this.scooterGeo || (this.scooterGeo = this.makeScooterGeo()), A.mat.darkSteel);
      for (const side of [-1, 1]) {
        let d = side < 0 ? bL - 8.5 : bR + 8.5;
        const lane = side < 0 ? -1.8 : 1.8;
        const nV = rng.int(0, 3);
        for (let i = 0; i < nV; i++) {
          const s = c.s + d * c.tan + lane / Math.cos(c.skew);
          r.frame(s, d, f);
          const yaw = -f.h + (side < 0 ? -Math.PI / 2 : Math.PI / 2);
          if (rng.chance(0.55)) {
            cars.add(f.x - ctx.O.x, T.height(s, d) + 0.08 - ctx.O.y, f.z - ctx.O.z, yaw, 1, 1, 1, rng.pick(CARS));
            d += side * 5.8;
          } else {
            for (let q = 0; q < 2; q++) {
              const s2 = s + (q ? 0.9 : -0.9);
              r.frame(s2, d, f);
              scoot.add(f.x - ctx.O.x, T.height(s2, d) + 0.08 - ctx.O.y, f.z - ctx.O.z, yaw, 1, 1, 1, null);
            }
            d += side * 2.4;
          }
        }
      }
      cars.build(ctx.group, ctx.inst);
      scoot.build(ctx.group, ctx.inst);
      this.crossings.set(c.id, { c, pivots, lamps, t: 0, active: false });
      ctx.crossings.push(c.id);
    }
  }

  makeCarGeo() {
    const a = new THREE.BoxGeometry(4.2, 0.75, 1.75).translate(0, 0.62, 0).toNonIndexed();
    const b = new THREE.BoxGeometry(2.2, 0.6, 1.55).translate(-0.2, 1.3, 0).toNonIndexed();
    return mergeGeometries([a, b]);
  }
  makeScooterGeo() {
    const a = new THREE.BoxGeometry(1.7, 0.55, 0.5).translate(0, 0.55, 0).toNonIndexed();
    const b = new THREE.BoxGeometry(0.45, 0.85, 0.45).translate(-0.1, 1.2, 0).toNonIndexed();
    const c = new THREE.SphereGeometry(0.2, 6, 5).translate(-0.1, 1.8, 0).toNonIndexed();
    c.deleteAttribute('uv');
    a.deleteAttribute('uv');
    b.deleteAttribute('uv');
    return mergeGeometries([a, b, c]);
  }

  // ---------------- scenery ----------------
  buildScenery(ctx) {
    const r = this.r, A = this.A, T = this.t;
    const rng = ctx.rng;
    const c0 = ctx.c0, c1 = ctx.c1;
    const p = T.params(c0 + CHUNK / 2);
    const occ = new Set();
    const cell = 6;
    const occCheck = (s, d, hs, hd, mark) => {
      const a0 = Math.floor((s - hs) / cell), a1 = Math.floor((s + hs) / cell);
      const b0 = Math.floor((d - hd) / cell), b1 = Math.floor((d + hd) / cell);
      for (let a = a0; a <= a1; a++) for (let b = b0; b <= b1; b++) if (occ.has(a * 100003 + b)) return false;
      if (mark) for (let a = a0; a <= a1; a++) for (let b = b0; b <= b1; b++) occ.add(a * 100003 + b);
      return true;
    };
    const f = this.tmp;
    const place = (s, d) => {
      r.frame(s, d, f);
      return f;
    };
    const flatBase = (s, d, hs, hd, maxRange) => {
      let mn = 1e9, mx = -1e9;
      for (const [ds, dd] of [[-hs, -hd], [hs, -hd], [-hs, hd], [hs, hd], [0, 0]]) {
        const h = T.height(s + ds, d + dd);
        mn = Math.min(mn, h);
        mx = Math.max(mx, h);
      }
      return mx - mn > maxRange ? null : { mn, mx };
    };
    const seaOK = (h) => !r.hasOcean || h > r.seaY + 1.2;

    // stations reserve their surroundings
    for (const st of r.stations) {
      if (st.yard[1] + 40 < c0 || st.yard[0] - 40 > c1) continue;
      for (let s = st.yard[0] - 10; s < st.yard[1] + 10; s += cell) {
        occCheck(s, -18, 0, 20, true);
        occCheck(s, 10, 0, 12, true);
      }
    }

    // --- buildings ---
    const town = p.town;
    const dens = p.bld * (0.3 + town * 1.9);
    const attempts = Math.round(dens * 60);
    const TH = A.townhouse.map((geo) => new Batch(geo, [A.mat.building, A.mat.roof], { shadow: true, receive: true }));
    const AP = A.apartment.map((geo) => new Batch(geo, [A.mat.building, A.mat.roof], { shadow: true, receive: true }));
    const shed = new Batch(A.shedGeo, A.mat.shed, { shadow: true });
    const tank = new Batch(A.tankGeo, A.mat.tank);
    const fac = new Batch(A.factoryGeo, A.mat.factory, { shadow: true, receive: true });
    const hb = new Batch(A.houseBody, A.mat.white, { shadow: true, receive: true });
    const hr = new Batch(A.houseRoof, A.mat.tileRoof, { shadow: true });
    let temple = town > 0.35 && rng.chance(0.14);
    for (let i = 0; i < attempts; i++) {
      const s = c0 + rng.next() * CHUNK;
      const side = rng.chance(0.5) ? -1 : 1;
      const [bL, bR] = r.bedAt(s);
      const dist = 12 + Math.pow(rng.next(), 1.7) * 360;
      const d = side < 0 ? bL - dist : bR + dist;
      if (T.isBlocked(s, d, 6)) continue;
      const pick = rng.next();
      if (temple) {
        if (!occCheck(s, d, 14, 12, false)) continue;
        const fb = flatBase(s, d, 12, 10, 2.5);
        if (!fb || !seaOK(fb.mn)) continue;
        occCheck(s, d, 14, 12, true);
        this.buildTemple(ctx, s, d, fb.mn);
        temple = false;
        continue;
      }
      if (pick < p.tall * town * 0.9) {
        const hs = 10.5, hd = 8;
        if (!occCheck(s, d, hs, hd, false)) continue;
        const fb = flatBase(s, d, hs, hd, 2.5);
        if (!fb || !seaOK(fb.mn)) continue;
        occCheck(s, d, hs, hd, true);
        const P = place(s, d);
        const v = rng.int(0, 2);
        AP[v].add(P.x - ctx.O.x, fb.mn - 0.4 - ctx.O.y, P.z - ctx.O.z, -P.h, 1, 1, 1, rng.pick(FACADE));
      } else if (pick < p.tall * town + 0.08 && p.paddy > 0.25 && town < 0.6) {
        if (!occCheck(s, d, 7, 5, false)) continue;
        const fb = flatBase(s, d, 6, 4, 1.8);
        if (!fb || !seaOK(fb.mn)) continue;
        occCheck(s, d, 7, 5, true);
        const P = place(s, d);
        const yaw = -P.h + (rng.chance(0.5) ? 0 : Math.PI / 2);
        hb.add(P.x - ctx.O.x, fb.mn - 0.2 - ctx.O.y, P.z - ctx.O.z, yaw, 1, 1, 1, rng.pick([0xe8e0d0, 0xb65a3c, 0xdad6cc]));
        hr.add(P.x - ctx.O.x, fb.mn - 0.2 - ctx.O.y, P.z - ctx.O.z, yaw, 1, 1, 1, rng.pick([0x55595e, 0xb4552a, 0x6d4a3a]));
      } else if (pick < p.tall * town + 0.16 && town < 0.7) {
        if (!occCheck(s, d, 16, 21, false)) continue;
        const fb = flatBase(s, d, 15, 20, 2.5);
        if (!fb || !seaOK(fb.mn)) continue;
        occCheck(s, d, 16, 21, true);
        const P = place(s, d);
        fac.add(P.x - ctx.O.x, fb.mn - 0.3 - ctx.O.y, P.z - ctx.O.z, -P.h, 1, 1, 1, rng.pick([0xdfe5ea, 0xa9c4dc, 0xd8d8d0, 0x9fb8a8]));
      } else {
        // row of townhouses 透天厝
        const n = rng.int(2, 8);
        for (let u = 0; u < n; u++) {
          const su = s + u * 5.6;
          if (su > c1) break;
          const [uL, uR] = r.bedAt(su);
          const du = side < 0 ? uL - dist : uR + dist;
          if (T.isBlocked(su, du, 4)) break;
          if (!occCheck(su, du, 2.7, 6.5, false)) break;
          const fb = flatBase(su, du, 2.7, 6.5, 2.0);
          if (!fb || !seaOK(fb.mn)) break;
          occCheck(su, du, 2.7, 6.5, true);
          const P = place(su, du);
          const fl = clamp(Math.floor(rng.next() * (2 + town * 2.5)) + (town > 0.5 ? 1 : 0), 0, 3);
          const hgt = [2, 3, 4, 5][fl] * 3.2 + 0.6;
          const x = P.x - ctx.O.x, z = P.z - ctx.O.z, yb = fb.mn - 0.3 - ctx.O.y;
          TH[fl].add(x, yb, z, -P.h, 1, 1, 1, rng.pick(FACADE));
          if (rng.chance(0.45)) shed.add(x, yb + hgt, z, -P.h, 5.2, 1, 8 + rng.range(-2, 3), rng.pick(SHED));
          else if (rng.chance(0.6)) tank.add(x + rng.range(-1, 1), yb + hgt, z, -P.h + 1.57, 1, 1, 1, null);
        }
      }
    }
    for (const b of [...TH, ...AP, shed, tank, fac, hb, hr]) b.build(ctx.group, ctx.inst);

    // --- rice paddies ---
    if (p.paddy > 0.05) {
      const dry = new Batch(A.paddyGeo, A.mat.paddy, { receive: true });
      const wet = new Batch(A.paddyGeo, A.mat.paddyWet, { receive: true });
      const PAL = [0x6f8f9c, 0x9cc25a, 0x6fa83a, 0x4f8a2a, 0xc9ae5a, 0x8a7a55];
      const cellS = rng.range(26, 38), cellD = rng.range(20, 30);
      for (const side of [-1, 1]) {
        for (let dist = 10; dist < 560; dist += cellD + 1.6) {
          for (let s = c0 + 1; s < c1 - cellS * 0.5; s += cellS + 1.6) {
            const sm = s + cellS / 2;
            const prob = T.params(sm).paddy * (1 - clamp(r.townAt(sm) * 1.1 - dist / 900, 0, 0.9));
            if (rng.next() > prob) continue;
            const [bL, bR] = r.bedAt(sm);
            const d = side < 0 ? bL - dist - cellD / 2 : bR + dist + cellD / 2;
            if (T.isBlocked(sm, d, Math.max(cellS, cellD) * 0.5)) continue;
            if (!occCheck(sm, d, cellS / 2 - 3.5, cellD / 2 - 3.5, true)) continue;
            const fb = flatBase(sm, d, cellS / 2, cellD / 2, 1.6);
            if (!fb || !seaOK(fb.mn)) continue;
            const n = this.t.n1.noise(sm * 0.0022, d * 0.0022 + 20);
            const stage = rng.next() < 0.22 + n * 0.3 ? 0 : clamp(Math.floor((n + 0.6) * 3 + rng.next() * 1.6), 1, 5);
            const P = place(sm, d);
            const B = stage === 0 ? wet : dry;
            B.add(P.x - ctx.O.x, fb.mx + 0.06 - ctx.O.y, P.z - ctx.O.z, -P.h, cellS, 1.8, cellD, PAL[stage]);
          }
        }
      }
      dry.build(ctx.group, ctx.inst);
      wet.build(ctx.group, ctx.inst);
    }

    // --- trees ---
    const trunks = new Batch(A.trunkGeo, A.mat.trunk, { shadow: true });
    const crowns = new Batch(A.canopyGeo, A.mat.leaf, { shadow: true });
    const greens = [0x3f6b2a, 0x4a7a32, 0x355f25, 0x5a8a3a, 0x2f5a2a];
    const nTrees = Math.round(p.tree * 55 * (0.5 + town * 0.8));
    for (let i = 0; i < nTrees; i++) {
      const s = c0 + rng.next() * CHUNK;
      const side = rng.chance(0.5) ? -1 : 1;
      const [bL, bR] = r.bedAt(s);
      const dist = 7 + Math.pow(rng.next(), 1.5) * 330;
      const d = side < 0 ? bL - dist : bR + dist;
      if (T.isBlocked(s, d, 1)) continue;
      if (!occCheck(s, d, 1.5, 1.5, false)) continue;
      const h = T.height(s, d, this.col);
      if (this.col.kind >= 2 && this.col.kind <= 5) continue;
      const P = place(s, d);
      const rad = rng.range(2.2, 4.8);
      const th = rng.range(1.6, 3.4);
      trunks.add(P.x - ctx.O.x, h - 0.2 - ctx.O.y, P.z - ctx.O.z, 0, rad / 2.6, th + rad * 0.5, rad / 2.6);
      crowns.add(P.x - ctx.O.x, h + th + rad * 0.55 - ctx.O.y, P.z - ctx.O.z, rng.next() * 6, rad, rad * 0.8, rad, rng.pick(greens));
    }
    trunks.build(ctx.group, ctx.inst);
    crowns.build(ctx.group, ctx.inst);

    // --- betel-nut palms 檳榔 ---
    const pt = new Batch(A.palmTrunkGeo, A.mat.palmTrunk, { shadow: true });
    const pc = new Batch(A.palmCrownGeo, A.mat.leaf, { shadow: true });
    const nCl = Math.floor(p.palm * 5 + rng.next());
    for (let i = 0; i < nCl; i++) {
      const s0 = c0 + rng.next() * CHUNK;
      const side = rng.chance(0.5) ? -1 : 1;
      const dist0 = 12 + rng.next() * 260;
      const cnt = rng.int(6, 20);
      const cols = rng.int(2, 4);
      for (let j = 0; j < cnt; j++) {
        const s = s0 + (j % cols) * 3.2 + rng.range(-0.6, 0.6);
        const dist = dist0 + Math.floor(j / cols) * 3.2 + rng.range(-0.6, 0.6);
        const [bL, bR] = r.bedAt(s);
        const d = side < 0 ? bL - dist : bR + dist;
        if (T.isBlocked(s, d, 1)) continue;
        if (!occCheck(s, d, 0.5, 0.5, false)) continue;
        const h = T.height(s, d, this.col);
        if (this.col.kind >= 2 && this.col.kind <= 5) continue;
        const P = place(s, d);
        const ht = rng.range(7, 13);
        pt.add(P.x - ctx.O.x, h - 0.2 - ctx.O.y, P.z - ctx.O.z, 0, 1, ht, 1);
        const cs = rng.range(0.85, 1.2);
        pc.add(P.x - ctx.O.x, h + ht - 0.4 - ctx.O.y, P.z - ctx.O.z, rng.next() * 6, cs, cs, cs, rng.pick([0x4d7a2a, 0x5f8a30, 0x6d8f38]));
      }
    }
    pt.build(ctx.group, ctx.inst);
    pc.build(ctx.group, ctx.inst);

    // --- forest on hillsides ---
    const fo = new Batch(A.forestGeo, A.mat.leaf);
    const fGreens = [0x2a4a22, 0x335a28, 0x2d5226, 0x3b612b, 0x24401e];
    const nF = Math.round(clamp(p.forest, 0, 1) * 420 + 60);
    for (let i = 0; i < nF; i++) {
      const s = c0 + rng.next() * CHUNK;
      const side = rng.chance(0.5) ? -1 : 1;
      const [bL, bR] = r.bedAt(s);
      const dist = 10 + Math.pow(rng.next(), 0.8) * 1100;
      const d = side < 0 ? bL - dist : bR + dist;
      if (T.isBlocked(s, d, 0)) continue;
      const h = T.height(s, d, this.col);
      if (this.col.kind >= 2 && this.col.kind <= 5) continue;
      const rel = h - r.yAt(s);
      if (p.forest < 0.6 && rel < 6) continue;
      if (rel < 3 && !occCheck(s, d, 2, 2, false)) continue;
      const P = place(s, d);
      const sc = rng.range(4, 9) * (dist > 400 ? 1.4 : 1);
      fo.add(P.x - ctx.O.x, h - 1 - ctx.O.y, P.z - ctx.O.z, rng.next() * 6, sc, sc * rng.range(0.9, 1.4), sc, rng.pick(fGreens));
    }
    fo.build(ctx.group, ctx.inst);

    // --- wind turbines ---
    if (p.turbine > 0.5 && r.hasOcean) {
      const SP = 320;
      for (let s = Math.ceil(c0 / SP) * SP; s < c1; s += SP) {
        let d = r.oceanSide * (p.coast - 20 + this.t.n3.noise(s * 0.01, 1) * 25);
        const lim = r.sideLimit(s);
        if (Math.abs(d) > (d < 0 ? lim[0] : lim[1]) * 0.9) continue;
        let h = T.height(s, d);
        for (let q = 0; q < 6 && h < r.seaY + 1.5; q++) {
          d -= r.oceanSide * 20;
          h = T.height(s, d);
        }
        if (h < r.seaY + 1 || T.isBlocked(s, d, 4)) continue;
        this.buildTurbine(ctx, s, d, h, rng);
      }
    }

    // --- rivers: water surface (built by the chunk containing the crossing) ---
    for (const rv of r.rivers) if (rv.s >= c0 && rv.s < c1) this.buildRiverWater(ctx, rv);
  }

  buildTemple(ctx, s, d, base) {
    const r = this.r, A = this.A;
    const f = r.frame(s, d, {});
    const g = new THREE.Group();
    g.position.set(f.x - ctx.O.x, base - ctx.O.y, f.z - ctx.O.z);
    g.rotation.y = -f.h + (d < 0 ? Math.PI / 2 : -Math.PI / 2);
    const add = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      g.add(m);
      ctx.own.push(geo);
      return m;
    };
    add(new THREE.BoxGeometry(22, 0.8, 16), A.mat.concrete, 0, 0.4, 0);
    add(new THREE.BoxGeometry(16, 5, 10), A.mat.templeRed, 0, 3.3, 0);
    const roof = add(prismGeo(13, 3.2, 19), A.mat.templeRoof, 0, 5.8, 0);
    roof.rotation.y = Math.PI / 2;
    add(new THREE.BoxGeometry(19.5, 0.35, 0.5), A.mat.templeRoof, 0, 9.05, 0);
    for (const x of [-9.6, 9.6]) {
      const horn = add(new THREE.ConeGeometry(0.35, 2.4, 6), A.mat.templeRoof, x, 9.6, 0);
      horn.rotation.z = x < 0 ? 0.6 : -0.6;
    }
    ctx.group.add(g);
  }

  buildTurbine(ctx, s, d, h, rng) {
    const r = this.r, A = this.A;
    const f = r.frame(s, d, {});
    const g = new THREE.Group();
    g.position.set(f.x - ctx.O.x, h - 1 - ctx.O.y, f.z - ctx.O.z);
    g.rotation.y = -f.h;
    if (!this.turbineGeo) {
      this.turbineGeo = new THREE.CylinderGeometry(1.1, 2.0, 72, 10).translate(0, 36, 0);
      this.nacelleGeo = new THREE.BoxGeometry(3, 3, 7);
      this.bladeGeo = new THREE.BoxGeometry(0.35, 34, 1.4).translate(0, 17, 0);
    }
    const tower = new THREE.Mesh(this.turbineGeo, A.mat.turbine);
    tower.castShadow = true;
    g.add(tower);
    const nac = new THREE.Mesh(this.nacelleGeo, A.mat.turbine);
    nac.position.set(0, 72.5, 0);
    g.add(nac);
    const rotor = new THREE.Group();
    rotor.position.set(0, 72.5, r.oceanSide * 3.8);
    for (let i = 0; i < 3; i++) {
      const b = new THREE.Mesh(this.bladeGeo, A.mat.turbine);
      b.rotation.z = (i / 3) * Math.PI * 2;
      b.castShadow = true;
      rotor.add(b);
    }
    rotor.rotation.z = rng.next() * 6;
    rotor.userData.speed = rng.range(0.6, 1.1);
    g.add(rotor);
    ctx.group.add(g);
    this.rotors.add(rotor);
    ctx.rotors.push(rotor);
  }

  buildRiverWater(ctx, rv) {
    const r = this.r;
    const f = this.tmp;
    const lim = r.sideLimit(rv.s);
    const cw = rv.W * rv.channel;
    const pos = [], idx = [];
    let n = 0;
    const d0 = -Math.min(1100, lim[0] * 0.9), d1 = Math.min(1100, lim[1] * 0.9);
    for (let d = d0; d <= d1; d += 8) {
      const uc = (rv.W / 2 - cw / 2) * Math.sin(d * 0.006 + rv.phase);
      for (const e of [-1, 1]) {
        const u = uc + (e * cw) / 2;
        const s = rv.s + d * rv.tan + u / rv.cos;
        r.frame(s, d, f);
        pos.push(f.x - ctx.O.x, rv.bedY + 0.4 - ctx.O.y, f.z - ctx.O.z);
      }
      if (n > 0) {
        const a = (n - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      n++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const nrm = g.attributes.normal;
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
    const m = this.mesh(ctx, g, this.waterMat || (this.waterMat = this.A.mat.water.clone()), { receive: true });
    this.waterMat.side = THREE.DoubleSide;
    return m;
  }

  // ---------------- dynamic ----------------
  updateDynamic(dt, now, trains) {
    for (const rot of this.rotors) rot.rotation.z += dt * rot.userData.speed;
    for (const cr of this.crossings.values()) {
      const c = cr.c;
      let active = false;
      for (const t of trains) {
        const lo = t.dir > 0 ? t.s - t.len - 25 : t.s - 700;
        const hi = t.dir > 0 ? t.s + 700 : t.s + t.len + 25;
        if (c.s > lo && c.s < hi) active = true;
      }
      cr.active = active;
      cr.t = clamp(cr.t + (active ? dt / 3.5 : -dt / 5), 0, 1);
      const ang = (Math.PI / 2) * cr.t;
      for (const pv of cr.pivots) pv.rotation.z = pv.userData.dir * ang;
      const blink = active && Math.floor(now * 2.4) % 2;
      cr.lamps.forEach((lm, i) => lm.material.color.set(active && (i % 2 === (blink ? 1 : 0)) ? 0xff2211 : 0x331111));
    }
  }
}

// Procedural route generation: horizontal alignment, vertical profile, stations,
// tunnels, bridges, level crossings, speed limits, signals and the timetable.

import { RNG, clamp, lerp, smoothstep } from './util.js';
import { THEMES, curveLimit } from './data.js';
import { tractionAccel, resistance, G } from './physics.js';

const STEP = 1; // sample spacing (m)

export class Route {
  constructor({ line, startIdx, stops, train, seed, difficulty }) {
    this.line = line;
    this.train = train;
    this.seed = seed;
    this.difficulty = difficulty;
    const rng = new RNG(seed);
    this.rng = rng;

    this.double = line.double;
    this.tracks = line.double ? [0, 4] : [0];
    this.oceanSide = line.oceanSide;
    this.seaY = 0;
    this.hasOcean = line.oceanSide !== 0;
    this.trainLen = train.cars * train.carLen + 2 * train.noseLen;
    this.tunnelHW = line.double ? 5.6 : 3.6;
    this.tunnelSpring = 3.4;

    // ---- stations -------------------------------------------------------
    const stList = [];
    let nStops = 0;
    for (let i = startIdx; i < line.stations.length; i++) {
      const src = line.stations[i];
      const isFirst = stList.length === 0;
      const stop = isFirst || train.type === 'local' || src.major;
      stList.push({ ...src, idx: i, stop });
      if (stop) nStops++;
      if (nStops >= stops) break;
    }
    stList[stList.length - 1].stop = true;
    this.stations = stList;

    let s = 800;
    stList.forEach((st, i) => {
      if (i > 0) {
        const th = THEMES[st.theme];
        s += Math.round(rng.range(th.interstation));
      }
      st.s = s; // stop point (front of train)
      st.platLen = st.major ? 300 : 230;
      st.pEnd = s + 10;
      st.pStart = st.pEnd - st.platLen;
      st.center = (st.pStart + st.pEnd) / 2;
      st.zone = [st.pStart - 170, st.pEnd + 170];
      st.yard = [st.pStart - 25, st.pEnd + 25];
      st.prev = line.stations[st.idx - 1] || null;
      st.next = line.stations[st.idx + 1] || null;
    });
    this.L = Math.ceil(s + 1000);
    const N = this.L + 2;
    this.N = N;

    // gaps between straight station zones, with the theme that applies there
    this.gaps = [];
    let g0 = 0;
    stList.forEach((st, i) => {
      this.gaps.push({ a: g0, b: st.zone[0], theme: THEMES[st.theme], themeName: st.theme, toStation: i });
      g0 = st.zone[1];
    });
    const lastTheme = stList[stList.length - 1].theme;
    this.gaps.push({ a: g0, b: N - 1, theme: THEMES[lastTheme], themeName: lastTheme, toStation: -1 });

    this.buildAlignment(rng);
    this.buildProfile(rng);
    this.placeTunnels(rng);
    this.placeRivers(rng);
    this.placeCrossings(rng);
    this.buildLimits(rng);
    this.placeSignals(rng);
    this.placeWhistles();
    this.sideCache = new Map();
    this.townCache = new Map();
  }

  // ---------------------------------------------------------------------
  buildAlignment(rng) {
    const N = this.N;
    const k = new Float32Array(N);
    let hdg = 0;
    for (const gap of this.gaps) {
      const th = gap.theme;
      let c = gap.a;
      for (;;) {
        c += rng.range(th.straight);
        if (c > gap.b - 150) break;
        const R = rng.range(th.curveR);
        let turn = (rng.range(th.turn) * Math.PI) / 180;
        const Ls = clamp(R * 0.12, 30, 90);
        let arc = R * turn - Ls;
        if (arc < 20) arc = 20;
        let total = 2 * Ls + arc;
        if (c + total > gap.b - 40) {
          const avail = gap.b - 40 - c;
          if (avail < 2 * Ls + 30) break;
          arc = avail - 2 * Ls;
          total = avail;
        }
        turn = (arc + Ls) / R;
        let dir = hdg > 0.45 ? -1 : hdg < -0.45 ? 1 : rng.chance(0.5) ? 1 : -1;
        const c0 = Math.floor(c);
        const tot = Math.floor(total);
        for (let i = 0; i < tot && c0 + i < N; i++) {
          const kk = i < Ls ? i / Ls : i < Ls + arc ? 1 : (tot - i) / Ls;
          k[c0 + i] = (dir * clamp(kk, 0, 1)) / R;
        }
        hdg += dir * turn;
        c += total;
      }
    }
    this.k = k;
    const x = new Float64Array(N), z = new Float64Array(N), h = new Float64Array(N);
    h[0] = rng.range(0, Math.PI * 2);
    for (let i = 1; i < N; i++) {
      const hm = h[i - 1] + k[i - 1] * 0.5;
      x[i] = x[i - 1] + Math.cos(hm);
      z[i] = z[i - 1] + Math.sin(hm);
      h[i] = h[i - 1] + k[i - 1];
    }
    this.x = x;
    this.z = z;
    this.h = h;
  }

  buildProfile(rng) {
    const N = this.N;
    const gr = new Float32Array(N);
    const base = this.line.baseY;
    let yEst = base;
    for (const gap of this.gaps) {
      const th = gap.theme;
      let c = gap.a;
      while (c < gap.b) {
        const len = rng.range(300, 900);
        let g = rng.range(-th.grade, th.grade) / 1000;
        const yMin = this.hasOcean ? 8 : base - 40;
        const yMax = th.maxY !== undefined ? th.maxY : base + (th.grade > 10 ? 240 : 45);
        if (yEst + g * len < yMin) g = Math.abs(g);
        if (yEst + g * len > yMax) g = -Math.abs(g);
        const end = Math.min(gap.b, c + len);
        for (let i = Math.floor(c); i < end; i++) gr[i] = g;
        yEst += g * (end - c);
        c = end;
      }
    }
    // smooth grade (vertical curves) with two box filters
    const smooth = (arr, w) => {
      const out = new Float32Array(N);
      const pre = new Float64Array(N + 1);
      for (let i = 0; i < N; i++) pre[i + 1] = pre[i] + arr[i];
      for (let i = 0; i < N; i++) {
        const a = Math.max(0, i - w), b = Math.min(N, i + w + 1);
        out[i] = (pre[b] - pre[a]) / (b - a);
      }
      return out;
    };
    const g2 = smooth(smooth(gr, 60), 60);
    const y = new Float32Array(N);
    y[0] = base;
    for (let i = 1; i < N; i++) y[i] = y[i - 1] + (g2[i - 1] + g2[i]) * 0.5;
    this.grade = g2;
    this.y = y;
  }

  placeTunnels(rng) {
    this.tunnels = [];
    for (const gap of this.gaps) {
      const th = gap.theme;
      if (!th.tunnel) continue;
      const len = gap.b - gap.a;
      const n = Math.floor((len / 1000) * th.tunnel + rng.next());
      for (let j = 0; j < n * 3 && this.tunnels.filter((t) => t.gap === gap).length < n; j++) {
        const tl = rng.range(160, th.tunnel > 0.5 ? 1400 : 700);
        const a = rng.range(gap.a + 180, gap.b - 180 - tl);
        if (a < gap.a + 180) continue;
        const b = a + tl;
        if (this.tunnels.some((t) => a < t.b + 260 && b > t.a - 260)) continue;
        this.tunnels.push({ a, b, gap, cover: Math.min(rng.range(40, 160), tl * 0.3 + 20) });
      }
    }
    this.tunnels.sort((p, q) => p.a - q.a);
  }

  placeRivers(rng) {
    this.rivers = [];
    this.bridges = [];
    for (const gap of this.gaps) {
      const th = gap.theme;
      const len = gap.b - gap.a;
      const tries = len > 3500 ? 2 : 1;
      for (let t = 0; t < tries; t++) {
        if (!rng.chance(th.river)) continue;
        const W = rng.range(th.riverW);
        const skew = rng.range(-0.35, 0.35);
        const cos = Math.cos(skew);
        const bank = th.riverDepth[1] > 12 ? rng.range(40, 80) : rng.range(8, 16);
        const halfS = (W / 2 + bank) / cos + 8;
        const sR = rng.range(gap.a + halfS + 30, gap.b - halfS - 30);
        if (sR - halfS < gap.a + 20) continue;
        const a = sR - halfS, b = sR + halfS;
        if (this.tunnels.some((tn) => a < tn.b + 60 && b > tn.a - 60)) continue;
        if (this.bridges.some((br) => a < br.b + 150 && b > br.a - 150)) continue;
        const depth = rng.range(th.riverDepth);
        let maxK = 0;
        for (let i = Math.floor(a); i < b; i++) maxK = Math.max(maxK, Math.abs(this.k[i]));
        const river = {
          s: sR, W, skew, tan: Math.tan(skew), cos, bank, depth,
          bedY: this.yAt(sR) - depth,
          channel: rng.range(0.25, 0.6),
          phase: rng.range(0, 6.28),
        };
        this.rivers.push(river);
        this.bridges.push({
          a, b, river,
          truss: W > 110 && maxK < 1e-5 && rng.chance(0.55),
          span: rng.range(28, 40),
        });
      }
    }
    this.rivers.sort((p, q) => p.s - q.s);
    this.bridges.sort((p, q) => p.a - q.a);
  }

  placeCrossings(rng) {
    this.crossings = [];
    for (const gap of this.gaps) {
      const th = gap.theme;
      const len = gap.b - gap.a;
      const n = Math.floor((len / 1000) * th.crossing + rng.next());
      for (let j = 0; j < n * 4 && this.crossings.filter((c) => c.gap === gap).length < n; j++) {
        const s = rng.range(gap.a + 60, gap.b - 60);
        if (this.tunnels.some((t) => s > t.a - 250 && s < t.b + 120)) continue;
        if (this.bridges.some((b) => s > b.a - 60 && s < b.b + 60)) continue;
        if (this.crossings.some((c) => Math.abs(c.s - s) < 400)) continue;
        this.crossings.push({ s, gap, skew: rng.range(-0.25, 0.25), id: this.crossings.length });
      }
    }
    this.crossings.sort((p, q) => p.s - q.s);
    this.crossings.forEach((c) => (c.tan = Math.tan(c.skew)));
  }

  buildLimits(rng) {
    const N = this.N;
    const lineMax = Math.min(this.line.vmax, this.train.vmax);
    this.lineMax = lineMax;
    const lim = new Uint8Array(N).fill(lineMax);
    const zones = [];
    const k = this.k;
    let i = 0;
    while (i < N) {
      if (k[i] !== 0) {
        let j = i, kmax = 0;
        while (j < N && k[j] !== 0) {
          kmax = Math.max(kmax, Math.abs(k[j]));
          j++;
        }
        const v = curveLimit(1 / kmax, this.train.tilt);
        if (v < lineMax) zones.push({ a: i, b: j + this.trainLen, v, kind: 'curve' });
        i = j;
      } else i++;
    }
    // occasional slow order (慢行) for track work
    this.slowOrders = [];
    if (rng.chance(0.55)) {
      const cands = this.gaps.filter((g) => g.b - g.a > 1500 && g.toStation > 0);
      if (cands.length) {
        const g = rng.pick(cands);
        const len = rng.range(250, 500);
        const a = rng.range(g.a + 300, g.b - 300 - len);
        const v = rng.pick([35, 45, 60]);
        if (a > g.a && !this.tunnels.some((t) => a < t.b && a + len > t.a)) {
          zones.push({ a, b: a + len + this.trainLen, v, kind: 'slow' });
          this.slowOrders.push({ a, b: a + len });
        }
      }
    }
    for (const zn of zones) {
      for (let s = Math.max(0, Math.floor(zn.a)); s < Math.min(N, zn.b); s++) lim[s] = Math.min(lim[s], zn.v);
    }
    this.lim = lim;
    this.limitZones = zones;

    // signs at limit changes
    this.signs = [];
    const slowAt = (s) => zones.some((z) => z.kind === 'slow' && s >= z.a - 2 && s <= z.b + 2);
    for (let s = 1; s < N; s++) {
      if (lim[s] < lim[s - 1]) {
        const slow = slowAt(s);
        this.signs.push({ s, kind: slow ? 'slow' : 'limit', v: lim[s] });
        if (s - 450 > 0) this.signs.push({ s: s - 450, kind: slow ? 'slowwarn' : 'warn', v: lim[s] });
      } else if (lim[s] > lim[s - 1]) {
        this.signs.push({ s, kind: slowAt(s - 1) ? 'slowend' : 'release', v: lim[s] });
      }
    }
    this.signs.sort((p, q) => p.s - q.s);
  }

  placeSignals(rng) {
    const sig = [];
    const st = this.stations;
    st.forEach((station, i) => {
      if (i > 0) sig.push({ s: station.pStart - 260, type: 'home', station: i });
      if (i < st.length - 1) sig.push({ s: station.pEnd + 50, type: 'start', station: i });
    });
    for (let i = 1; i < st.length; i++) {
      const a = st[i - 1].pEnd + 50;
      const b = st[i].pStart - 260;
      const n = Math.floor((b - a) / 1500);
      const sp = (b - a) / (n + 1);
      for (let j = 1; j <= n; j++) {
        let s = a + j * sp + rng.range(-120, 120);
        if (this.crossings.some((c) => Math.abs(c.s - s) < 30)) s += 60;
        sig.push({ s, type: 'auto' });
      }
    }
    sig.sort((p, q) => p.s - q.s);
    sig.forEach((g, i) => {
      g.id = i;
      g.base = 3;
      g.group = -1;
    });
    // restrictive-aspect events (preceding train ahead)
    this.events = [];
    const nEv = this.difficulty.events;
    const cands = sig.filter((g, i) => g.type !== 'start' && g.s > 2600 && i >= 2);
    let guard = 0;
    while (this.events.length < nEv && cands.length && guard++ < 50) {
      const g = rng.pick(cands);
      if (this.events.some((e) => Math.abs(e.main - g.id) < 4)) continue;
      const kind = rng.chance(0.45) ? 'stop' : 'caution';
      const delay = kind === 'stop' ? rng.range(30, 50) : rng.range(10, 24);
      const ev = { main: g.id, kind, members: [], delay, t0: -1, trigger: 0 };
      const i = g.id;
      if (kind === 'stop') {
        sig[i].base = 0;
        if (sig[i - 1] && sig[i - 1].type !== 'start') sig[i - 1].base = 1;
        if (sig[i - 2] && sig[i - 2].type !== 'start' && sig[i - 1].type !== 'start') sig[i - 2].base = 2;
      } else {
        sig[i].base = 1;
        if (sig[i - 1] && sig[i - 1].type !== 'start') sig[i - 1].base = 2;
      }
      for (let m = i; m >= Math.max(0, i - 2); m--) {
        if (sig[m].base < 3) {
          sig[m].group = this.events.length;
          ev.members.push(m);
          ev.trigger = sig[m].s;
        }
      }
      this.events.push(ev);
    }
    this.signals = sig;
  }

  placeWhistles() {
    this.whistles = [];
    for (const c of this.crossings) this.whistles.push({ s: c.s - 330, end: c.s - 5, kind: 'crossing' });
    for (const t of this.tunnels) this.whistles.push({ s: t.a - 260, end: t.a - 10, kind: 'tunnel' });
    this.whistles = this.whistles.filter((w) => w.s > 100);
    this.whistles.sort((p, q) => p.s - q.s);
    this.whistles.forEach((w, i) => (w.id = i));
  }

  // ---- queries ------------------------------------------------------------
  idx(s) {
    return clamp(s, 0, this.N - 1.001);
  }
  yAt(s) {
    s = this.idx(s);
    const i = Math.floor(s), f = s - i;
    return this.y[i] + (this.y[i + 1] - this.y[i]) * f;
  }
  gradeAt(s) {
    return this.grade[Math.floor(this.idx(s))];
  }
  headingAt(s) {
    s = this.idx(s);
    const i = Math.floor(s), f = s - i;
    return this.h[i] + (this.h[i + 1] - this.h[i]) * f;
  }
  curvAt(s) {
    return this.k[Math.floor(this.idx(s))];
  }
  limitAt(s) {
    return this.lim[Math.floor(this.idx(s))];
  }
  // world position of track-local (s, d); writes x, y (rail top at centreline), z, h
  frame(s, d, out) {
    const c = this.idx(s);
    const i = Math.floor(c), f = c - i;
    const hh = this.h[i] + (this.h[i + 1] - this.h[i]) * f;
    const x = this.x[i] + (this.x[i + 1] - this.x[i]) * f;
    const z = this.z[i] + (this.z[i + 1] - this.z[i]) * f;
    const s0 = Math.sin(hh), c0 = Math.cos(hh);
    const extra = s - c; // extrapolate beyond ends
    out.x = x + c0 * extra - s0 * d;
    out.z = z + s0 * extra + c0 * d;
    out.y = this.y[i] + (this.y[i + 1] - this.y[i]) * f;
    out.h = hh;
    return out;
  }

  tunnelAt(s) {
    for (const t of this.tunnels) if (s > t.a && s < t.b) return t;
    return null;
  }
  bridgeAt(s) {
    for (const b of this.bridges) if (s > b.a && s < b.b) return b;
    return null;
  }
  stationAt(s, margin = 0) {
    for (const st of this.stations) if (s > st.yard[0] - margin && s < st.yard[1] + margin) return st;
    return null;
  }
  // formation (flat bed) extents at s, widened into a yard at stations
  bedAt(s) {
    let L = -3.4, R = this.double ? 7.4 : 3.4;
    for (const st of this.stations) {
      if (s > st.yard[0] - 60 && s < st.yard[1] + 60) {
        const t = Math.min(smoothstep(st.yard[0] - 60, st.yard[0], s), 1 - smoothstep(st.yard[1], st.yard[1] + 60, s));
        L = lerp(L, -34, t);
        R = lerp(R, this.double ? 16 : 8, t);
      }
    }
    return [L, R];
  }
  townAt(s) {
    const key = Math.round(s / 25);
    let v = this.townCache.get(key);
    if (v !== undefined) return v;
    v = 0;
    for (const st of this.stations) {
      const r = st.major ? 1100 : 600;
      const q = (s - st.center) / r;
      v = Math.max(v, Math.exp(-q * q) * (st.major ? 1 : 0.75));
    }
    this.townCache.set(key, v);
    return v;
  }

  // Max lateral extent on [left, right] before track-normal lines start crossing (inner side of curves).
  sideLimit(s) {
    const key = Math.round(s / 10);
    let v = this.sideCache.get(key);
    if (v) return v;
    s = key * 10;
    const P = {}, Q = {};
    this.frame(s, 0, P);
    const nix = -Math.sin(P.h), niz = Math.cos(P.h);
    const res = [4000, 4000];
    for (let m = -100; m <= 100; m++) {
      if (m === 0) continue;
      const sj = s + m * 20;
      if (sj < 0 || sj > this.L) continue;
      this.frame(sj, 0, Q);
      const njx = -Math.sin(Q.h), njz = Math.cos(Q.h);
      const dx = Q.x - P.x, dz = Q.z - P.z;
      for (let side = 0; side < 2; side++) {
        const sg = side === 0 ? -1 : 1;
        const det = sg * (-nix * njz + njx * niz);
        if (Math.abs(det) < 1e-7) continue;
        const t = (-dx * njz + njx * dz) / det;
        const u = (sg * nix * dz - sg * niz * dx) / det;
        if (t > 0 && u * sg > 0) res[side] = Math.min(res[side], t * 0.9);
      }
    }
    v = res;
    this.sideCache.set(key, v);
    return v;
  }

  // Signals / limits lookups for HUD
  nextSignalIndex(s) {
    const sig = this.signals;
    for (let i = 0; i < sig.length; i++) if (sig[i].s > s) return i;
    return -1;
  }
  nextLimitDrop(s, range = 2500) {
    const cur = this.limitAt(s);
    const end = Math.min(this.N - 1, Math.floor(s + range));
    for (let i = Math.floor(s) + 1; i < end; i++) {
      if (this.lim[i] < cur) return { s: i, v: this.lim[i] };
    }
    return null;
  }

  // ---- timetable ------------------------------------------------------------
  buildSchedule(slack, startClock) {
    const sp = this.train;
    const st = this.stations;
    const firstDwell = 22;
    st[0].arr = null;
    st[0].dep = startClock + firstDwell;
    let prevStop = 0;
    for (let i = 1; i < st.length; i++) {
      if (!st[i].stop) continue;
      const a = st[prevStop].s, b = st[i].s;
      const prof = this.parProfile(a, b, sp);
      let extra = 0;
      for (const ev of this.events) {
        const sm = this.signals[ev.main].s;
        if (sm > a && sm < b) extra += ev.kind === 'stop' ? 25 : 12;
      }
      const run = Math.ceil((prof.total * slack + 6 + extra) / 5) * 5;
      const dep0 = st[prevStop].dep;
      for (let j = prevStop + 1; j < i; j++) {
        const tt = prof.cum[Math.floor(st[j].s - a)] * slack;
        st[j].pass = dep0 + Math.round(tt + 3);
      }
      st[i].arr = dep0 + run;
      st[i].dep = i === st.length - 1 ? null : st[i].arr + sp.dwell;
      st[i].par = prof.total;
      prevStop = i;
    }
  }

  parProfile(a, b, sp) {
    const n = Math.floor(b - a);
    const v = new Float64Array(n + 1);
    const vl = (j) => this.lim[Math.floor(a + j)] / 3.6;
    v[0] = 0;
    for (let j = 0; j < n; j++) {
      const g = this.grade[Math.floor(a + j)];
      const acc = tractionAccel(sp, v[j], 1) - resistance(v[j]) - G * g;
      v[j + 1] = Math.min(vl(j + 1), Math.sqrt(Math.max(0, v[j] * v[j] + 2 * acc)));
    }
    v[n] = 0;
    const bk = (sp.brake / 3.6) * 0.7;
    for (let j = n - 1; j >= 0; j--) {
      const g = this.grade[Math.floor(a + j)];
      const dec = Math.max(0.2, bk + G * g);
      v[j] = Math.min(v[j], Math.sqrt(v[j + 1] * v[j + 1] + 2 * dec));
    }
    const cum = new Float64Array(n + 1);
    for (let j = 0; j < n; j++) {
      const avg = Math.max(0.35, (v[j] + v[j + 1]) * 0.5);
      cum[j + 1] = cum[j] + 1 / avg;
    }
    return { total: cum[n], cum, v };
  }
}

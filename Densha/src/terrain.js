// Terrain height / colour field expressed in track-local coordinates (s along track, d lateral, +d = right).

import { Noise2D, clamp, lerp, smoothstep } from './util.js';
import { THEMES } from './data.js';

const NUM_KEYS = [
  'relief', 'mAL', 'mDL', 'mRL', 'mAR', 'mDR', 'mRR', 'coast', 'bld', 'tall', 'paddy', 'tree', 'palm',
  'forest', 'wall', 'turbine', 'gr', 'gg', 'gb',
];

function themeVector(th, oceanSide) {
  const v = {};
  v.relief = th.relief;
  const none = { a: 0, dist: 5000, ramp: 100 };
  let left = th.mount || none, right = th.mount || none;
  const oceanIsLeft = oceanSide < 0;
  if (th.coast || th.flatSea || th.landMount) {
    const land = th.landMount || th.mount || none;
    if (oceanIsLeft) {
      left = none;
      right = land;
    } else {
      right = none;
      left = land;
    }
  }
  v.mAL = left.a; v.mDL = left.dist; v.mRL = left.ramp;
  v.mAR = right.a; v.mDR = right.dist; v.mRR = right.ramp;
  v.coast = th.coast && oceanSide !== 0 ? th.coast : 5000;
  v.bld = th.bld; v.tall = th.tall; v.paddy = th.paddy; v.tree = th.tree; v.palm = th.palm;
  v.forest = th.forest; v.wall = th.wall; v.turbine = th.turbine;
  v.gr = th.ground[0]; v.gg = th.ground[1]; v.gb = th.ground[2];
  return v;
}

export class Terrain {
  constructor(route) {
    this.r = route;
    this.n1 = new Noise2D(route.seed ^ 0x51ed27);
    this.n2 = new Noise2D(route.seed ^ 0x1b873593);
    this.n3 = new Noise2D(route.seed ^ 0x2545f491);
    this.pcache = new Map();
    const os = route.oceanSide;
    this.vecs = route.stations.map((st) => themeVector(THEMES[st.theme], os));
    this.tmp = {};
  }

  // Theme parameters blended around station boundaries.
  params(s) {
    const key = Math.round(s / 20);
    let p = this.pcache.get(key);
    if (p) return p;
    s = key * 20;
    const st = this.r.stations;
    let i = 0;
    while (i < st.length - 1 && s > st[i].s) i++;
    // section i covers (st[i-1].s, st[i].s]
    let a = this.vecs[i], b = null, t = 0;
    if (i > 0 && s < st[i - 1].s + 700) {
      b = this.vecs[i - 1];
      t = 1 - smoothstep(st[i - 1].s - 700, st[i - 1].s + 700, s);
    } else if (s > st[i].s - 700 && i < st.length - 1) {
      b = this.vecs[i + 1];
      t = smoothstep(st[i].s - 700, st[i].s + 700, s);
    }
    p = {};
    for (const k of NUM_KEYS) p[k] = b ? lerp(a[k], b[k], t) : a[k];
    p.town = this.r.townAt(s);
    this.pcache.set(key, p);
    return p;
  }

  tunnelBump(s) {
    let bump = 0;
    for (const t of this.r.tunnels) {
      if (s < t.a - 200 || s > t.b + 200) continue;
      let v;
      if (s < t.a) v = 22 * smoothstep(t.a - 170, t.a, s);
      else if (s > t.b) v = 22 * (1 - smoothstep(t.b, t.b + 170, s));
      else {
        const u = (s - t.a) / (t.b - t.a);
        v = 22 + t.cover * Math.sqrt(Math.sin(Math.PI * u));
      }
      bump = Math.max(bump, v);
    }
    return bump;
  }

  // natural ground height relative to rail level y(s); sets this.kind
  natural(s, d, y) {
    const p = this.params(s);
    const ad = Math.abs(d);
    let h = p.relief * this.n1.fbm(s * 0.0035, d * 0.0035 + 100, 3);
    this.kind = 0; // 0 ground, 1 forest/mountain, 2 riverbed, 3 sand, 4 seabed
    const right = d >= 0;
    const mA = right ? p.mAR : p.mAL;
    if (mA > 1) {
      const mD = right ? p.mDR : p.mDL;
      const mR = right ? p.mRR : p.mRL;
      const t = smoothstep(mD, mD + mR, ad);
      if (t > 0) {
        const r = this.n2.ridged(s * 0.0011 + (right ? 40 : 0), ad * 0.0013, 4);
        const m = mA * t * (0.3 + 0.95 * r);
        h += m;
        if (m > 18) this.kind = 1;
      }
    }
    const tb = this.tunnelBump(s);
    if (tb > 0) {
      h += tb * (1 - smoothstep(500, 1800, ad));
      if (tb > 15) this.kind = 1;
    }
    // coast
    const os = this.r.oceanSide;
    if (os !== 0 && (d * os) > 0 && p.coast < 4000) {
      const cd = p.coast + 45 * this.n3.noise(s * 0.0025, 3.3);
      if (ad > cd - 30) {
        const seaRel = this.r.seaY - y;
        const t = smoothstep(cd, cd + 70, ad);
        const floor = seaRel - 1.2 - Math.min(18, Math.max(0, ad - cd - 70) * 0.06);
        const hb = lerp(h, floor, t);
        h = Math.min(h, hb);
        if (h < seaRel + 1.5) this.kind = h < seaRel - 0.6 ? 4 : 3;
      }
    }
    // rivers
    for (const rv of this.r.rivers) {
      if (Math.abs(s - rv.s) > 1200) continue;
      const u = (s - rv.s - d * rv.tan) * rv.cos;
      const au = Math.abs(u);
      const hw = rv.W / 2;
      if (au < hw + rv.bank) {
        const t = smoothstep(hw + rv.bank, hw, au);
        const bed = rv.bedY - y;
        h = lerp(h, Math.min(h, bed), t);
        if (t > 0.85) this.kind = 2;
      }
      // softer valley in mountains
      if (rv.bank > 30 && au < hw + rv.bank * 4) {
        const t2 = smoothstep(hw + rv.bank * 4, hw + rv.bank, au);
        h = lerp(h, Math.min(h, rv.bedY - y + 25), t2 * 0.7);
      }
    }
    return h;
  }

  // Absolute terrain height. Writes colour to out.r/g/b when out given.
  height(s, d, out) {
    const r = this.r;
    const y = r.yAt(s);
    const [bL, bR] = r.bedAt(s);
    let nat = y + this.natural(s, d, y);
    let kind = this.kind;
    let h;
    const tun = r.tunnelAt(s);
    const bedC = r.double ? 2 : 0;
    if (tun) {
      if (Math.abs(d - bedC) < r.tunnelHW + 8) nat = Math.max(nat, y + r.tunnelSpring + r.tunnelHW + 3);
      h = nat;
      kind = 1;
    } else {
      const fY = y - 0.75;
      const dist = d < bL ? bL - d : d > bR ? d - bR : 0;
      const br = r.bridgeAt(s);
      if (br) {
        h = Math.abs(d - bedC) < 14 ? Math.min(nat, y - 3.4) : nat;
      } else if (dist === 0) {
        h = fY;
        kind = 5;
      } else {
        const diff = nat - fY;
        const lim = dist / 1.35 + 0.15;
        if (Math.abs(diff) <= lim) h = nat;
        else {
          h = fY + Math.sign(diff) * lim;
          kind = 6;
        }
      }
    }
    if (out) this.colour(s, d, h, y, kind, out);
    return h;
  }

  colour(s, d, h, y, kind, out) {
    const p = this.params(s);
    const n = this.n3.noise(s * 0.02, d * 0.02) * 0.5 + this.n1.noise(s * 0.004, d * 0.004 + 50) * 0.5;
    let r = p.gr, g = p.gg, b = p.gb;
    // towns: dusty grey ground
    const town = p.town * p.bld;
    r = lerp(r, 0.47, clamp(town, 0, 0.8));
    g = lerp(g, 0.46, clamp(town, 0, 0.8));
    b = lerp(b, 0.41, clamp(town, 0, 0.8));
    const rel = h - y;
    const pd = clamp(p.paddy * (1 - p.town), 0, 1) * 0.55;
    if (kind === 0 && Math.abs(rel) < 6) {
      r = lerp(r, 0.5, pd); g = lerp(g, 0.47, pd); b = lerp(b, 0.31, pd);
    }
    if (kind === 1 || (rel > 14 && p.forest > 0.05)) {
      const t = clamp((rel - 8) / 30, 0, 1);
      r = lerp(r, 0.16, t); g = lerp(g, 0.30, t); b = lerp(b, 0.14, t);
    }
    if (kind === 5) {
      const st = this.r.stationAt(s);
      if (st && Math.abs(d) > 5) { r = 0.52; g = 0.51; b = 0.49; } else { r = 0.40; g = 0.37; b = 0.33; }
    } else if (kind === 6) {
      r = lerp(r, 0.33, 0.5); g = lerp(g, 0.45, 0.5); b = lerp(b, 0.22, 0.5);
    } else if (kind === 2) {
      r = 0.6; g = 0.58; b = 0.53;
    } else if (kind === 3) {
      r = 0.78; g = 0.72; b = 0.57;
    } else if (kind === 4) {
      r = 0.33; g = 0.42; b = 0.40;
    }
    const v = 1 + n * 0.22;
    out.r = Math.pow(clamp(r * v, 0, 1), 2.2);
    out.g = Math.pow(clamp(g * v, 0, 1), 2.2);
    out.b = Math.pow(clamp(b * v, 0, 1), 2.2);
    out.kind = kind;
  }

  // Coarse flags for scenery placement
  isBlocked(s, d, pad = 0) {
    const r = this.r;
    const [bL, bR] = r.bedAt(s);
    if (d > bL - 6 - pad && d < bR + 6 + pad) return true;
    if (r.tunnelAt(s)) return true;
    for (const b of r.bridges) {
      const rv = b.river;
      const u = Math.abs((s - rv.s - d * rv.tan) * rv.cos);
      if (u < rv.W / 2 + rv.bank + 6 + pad) return true;
    }
    for (const c of r.crossings) {
      if (Math.abs(s - c.s - d * c.tan) < 9 + pad) return true;
    }
    const lim = r.sideLimit(s);
    if (d < 0 ? -d > lim[0] * 0.95 : d > lim[1] * 0.95) return true;
    return false;
  }
}

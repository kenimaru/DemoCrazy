// Shared math helpers, seeded RNG and gradient noise.

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashInts(...args) {
  let h = 2166136261;
  for (const v of args) {
    h ^= v | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class RNG {
  constructor(seed) {
    this.f = mulberry32(seed >>> 0);
  }
  next() {
    return this.f();
  }
  range(a, b) {
    if (Array.isArray(a)) [a, b] = a;
    return a + (b - a) * this.f();
  }
  int(a, b) {
    return Math.floor(a + (b - a + 1) * this.f());
  }
  pick(arr) {
    return arr[Math.floor(this.f() * arr.length)];
  }
  chance(p) {
    return this.f() < p;
  }
}

const GRAD = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1.41, 0], [-1.41, 0], [0, 1.41], [0, -1.41],
];

export class Noise2D {
  constructor(seed) {
    const rng = new RNG(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  noise(x, y) {
    const X = Math.floor(x);
    const Y = Math.floor(y);
    const xf = x - X;
    const yf = y - Y;
    const xi = X & 255;
    const yi = Y & 255;
    const P = this.perm;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const g = (h, dx, dy) => {
      const gr = GRAD[h & 7];
      return gr[0] * dx + gr[1] * dy;
    };
    const aa = P[P[xi] + yi];
    const ab = P[P[xi] + yi + 1];
    const ba = P[P[xi + 1] + yi];
    const bb = P[P[xi + 1] + yi + 1];
    const x1 = lerp(g(aa, xf, yf), g(ba, xf - 1, yf), u);
    const x2 = lerp(g(ab, xf, yf - 1), g(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  }

  fbm(x, y, oct = 4) {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let i = 0; i < oct; i++) {
      sum += amp * this.noise(x * f, y * f);
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return sum / norm;
  }

  // 0..1, sharp crests
  ridged(x, y, oct = 4) {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let i = 0; i < oct; i++) {
      const n = 1 - Math.abs(this.noise(x * f, y * f));
      sum += amp * n * n;
      norm += amp;
      amp *= 0.5;
      f *= 2.1;
    }
    return sum / norm;
  }
}

export function formatClock(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600) % 24;
  const m = Math.floor(t / 60) % 60;
  const s = Math.floor(t % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// sRGB-ish 0..1 -> linear, for vertex colours
export const lin = (c) => Math.pow(c, 2.2);

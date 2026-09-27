// Procedural TRA rolling stock models. Car local frame: +X = forward, +Y = up, +Z = right, y=0 at rail top.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { canvasTex, destTexture } from './assets.js';
import { clamp } from './util.js';

const HW = 1.45; // half width
const HALF = 9.8; // half body length
const PROFILE = [
  [-HW, 1.0], [-HW, 3.0], [-1.40, 3.22], [-1.28, 3.40], [-1.0, 3.55], [-0.5, 3.64], [0, 3.66],
  [0.5, 3.64], [1.0, 3.55], [1.28, 3.40], [1.40, 3.22], [HW, 3.0], [HW, 1.0],
];
const SMOOTH = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10]);

const NOSE = {
  EMU800: { sy: (t) => 1 - 0.14 * Math.pow(t, 1.5), sz: (t) => 1 - 0.07 * t * t, win: 2.05 },
  EMU3000: { sy: (t) => 1 - 0.34 * Math.pow(t, 1.7), sz: (t) => 1 - 0.22 * t * t, win: 2.0 },
  TEMU2000: { sy: (t) => 1 - 0.52 * Math.pow(t, 1.35), sz: (t) => 1 - 0.4 * t * t, win: 1.95 },
  E1000: { sy: (t) => 1 - 0.3 * Math.pow(t, 1.5), sz: (t) => 1 - 0.14 * t * t, win: 2.1 },
};

function profileNormals() {
  const segN = [];
  for (let j = 0; j < PROFILE.length - 1; j++) {
    const [z0, y0] = PROFILE[j], [z1, y1] = PROFILE[j + 1];
    const dz = z1 - z0, dy = y1 - y0;
    const l = Math.hypot(dz, dy);
    segN.push([-dy / l, dz / l]); // (nz, ny)
  }
  return segN;
}
const SEG_N = profileNormals();
function pointNormal(j, seg) {
  if (!SMOOTH.has(j)) return SEG_N[seg];
  const a = SEG_N[j - 1], b = SEG_N[j];
  const nz = a[0] + b[0], ny = a[1] + b[1];
  const l = Math.hypot(nz, ny);
  return [nz / l, ny / l];
}

// arc-length fraction over the roof for UV v
const roofLen = (() => {
  let acc = [0];
  for (let j = 1; j < PROFILE.length; j++) {
    const [z0, y0] = PROFILE[j - 1], [z1, y1] = PROFILE[j];
    acc.push(acc[j - 1] + Math.hypot(z1 - z0, y1 - y0));
  }
  return acc;
})();
function vCoord(j) {
  const [, y] = PROFILE[j];
  if (j === 0 || j === PROFILE.length - 1 || y <= 3.0 + 1e-6) return ((y - 1.0) / 2.0) * 0.8;
  const a = roofLen[1], b = roofLen[PROFILE.length - 2];
  return 0.8 + 0.2 * ((roofLen[j] - a) / (b - a));
}

function bodyGeometry() {
  const pos = [], nor = [], uv = [];
  for (let j = 0; j < PROFILE.length - 1; j++) {
    const [z0, y0] = PROFILE[j], [z1, y1] = PROFILE[j + 1];
    const n0 = pointNormal(j, j), n1 = pointNormal(j + 1, j);
    const v0 = vCoord(j), v1 = vCoord(j + 1);
    const quad = [
      [-HALF, y0, z0, n0, 0, v0], [HALF, y0, z0, n0, 1, v0], [HALF, y1, z1, n1, 1, v1],
      [-HALF, y0, z0, n0, 0, v0], [HALF, y1, z1, n1, 1, v1], [-HALF, y1, z1, n1, 0, v1],
    ];
    // winding: ensure outward-facing (flip for left half)
    const tri = z0 + z1 < 0 || (z0 + z1 === 0 && y1 > y0) ? [0, 2, 1, 3, 5, 4] : [0, 1, 2, 3, 4, 5];
    for (const q of tri) {
      const [x, y, z, n, u, v] = quad[q];
      pos.push(x, y, z);
      nor.push(0, n[1], n[0]);
      uv.push(u, v);
    }
  }
  // underside
  const b = [[-HALF, 1.0, -HW], [HALF, 1.0, -HW], [HALF, 1.0, HW], [-HALF, 1.0, HW]];
  for (const q of [0, 1, 2, 0, 2, 3]) {
    pos.push(...b[q]);
    nor.push(0, -1, 0);
    uv.push(0, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  fixWinding(g);
  return g;
}

// Make triangle winding agree with the supplied normals.
function fixWinding(g) {
  const p = g.attributes.position, n = g.attributes.normal;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nn = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1);
    c.fromBufferAttribute(p, i + 2);
    b.sub(a);
    c.sub(a);
    b.cross(c);
    nn.fromBufferAttribute(n, i).add(new THREE.Vector3().fromBufferAttribute(n, i + 1)).add(new THREE.Vector3().fromBufferAttribute(n, i + 2));
    if (b.dot(nn) < 0) {
      for (const attr of Object.values(g.attributes)) {
        const s = attr.itemSize;
        for (let k = 0; k < s; k++) {
          const t = attr.array[(i + 1) * s + k];
          attr.array[(i + 1) * s + k] = attr.array[(i + 2) * s + k];
          attr.array[(i + 2) * s + k] = t;
        }
      }
    }
  }
}

function endCapGeometry(x, facing) {
  const shape = new THREE.Shape();
  PROFILE.forEach(([z, y], i) => (i ? shape.lineTo(z, y) : shape.moveTo(z, y)));
  const g = new THREE.ShapeGeometry(shape);
  // shape is in XY; map (sx, sy) -> (x, y, z=sx) facing +x or -x
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const sx = p.getX(i), sy = p.getY(i);
    p.setXYZ(i, x, sy, sx);
  }
  g.computeVertexNormals();
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, facing, 0, 0);
  const ng = g.toNonIndexed();
  fixWinding(ng);
  return ng;
}

function noseGeometry(spec) {
  const style = NOSE[spec.model] || NOSE.EMU800;
  const L = spec.noseLen;
  const lv = spec.livery;
  const col = (hex) => new THREE.Color(hex);
  const cBody = col(lv.body), cFront = col(lv.front), cGlass = col('#0d1115'), cStripe = col(lv.stripe),
    cRoof = col(lv.roof), cSkirt = col('#3a3d40');
  const K = 10;
  const rings = [];
  for (let k = 0; k <= K; k++) {
    const t = k / K;
    const sy = style.sy(t), sz = style.sz(t);
    rings.push(PROFILE.map(([z, y]) => [HALF + t * L, 1.0 + (y - 1.0) * sy, z * sz, t]));
  }
  const colourAt = (x, y, z, t, cap) => {
    const topY = 1.0 + 2.66 * style.sy(t);
    const inWin = y > style.win && y < topY - 0.12 && (cap || t > 0.35);
    if (inWin) return cGlass;
    if (y < 1.12) return cSkirt;
    if (spec.model === 'TEMU2000') return t > 0.12 || cap ? cFront : cBody;
    if (spec.model === 'EMU800') {
      if (cap || t > 0.75) return y < style.win ? cFront : cBody;
      if (y > 2.95) return cRoof;
      return cBody;
    }
    if (spec.model === 'EMU3000') {
      if (y > 1.62 && y < 1.74) return cStripe;
      if (y > 3.0 && !cap && t < 0.5) return cRoof;
      return cBody;
    }
    if (spec.model === 'E1000') return y < 1.9 ? cFront : cBody;
    return cBody;
  };
  const pos = [], nor = [], colr = [];
  const push = (p, c) => {
    pos.push(p[0], p[1], p[2]);
    colr.push(c.r, c.g, c.b);
  };
  for (let k = 0; k < K; k++) {
    const A = rings[k], B = rings[k + 1];
    for (let j = 0; j < PROFILE.length - 1; j++) {
      const q = [A[j], A[j + 1], B[j + 1], A[j], B[j + 1], B[j]];
      for (const p of q) push(p, colourAt(p[0], p[1], p[2], p[3], false));
    }
    // bottom strip
    const q = [A[0], B[0], B[PROFILE.length - 1], A[0], B[PROFILE.length - 1], A[PROFILE.length - 1]];
    for (const p of q) push(p, cSkirt);
  }
  // front cap (fan)
  const last = rings[K];
  let cy = 0, cz = 0;
  last.forEach((p) => { cy += p[1]; cz += p[2]; });
  cy /= last.length; cz /= last.length;
  const tip = [HALF + L + 0.06, cy, cz, 1];
  for (let j = 0; j < last.length; j++) {
    const a = last[j], b = last[(j + 1) % last.length];
    for (const p of [tip, a, b]) push(p, colourAt(p[0], p[1], p[2], 1, true));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  // colours are sRGB hex -> THREE.Color already linear
  g.computeVertexNormals();
  // orient outward: normals from centre axis
  const p = g.attributes.position, n = g.attributes.normal;
  const v = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    c.set(v.x, 2.2, 0);
    const out = v.clone().sub(c);
    if (v.x > HALF + L - 0.02) out.x += 1.5;
    const nn = new THREE.Vector3().fromBufferAttribute(n, i);
    if (nn.dot(out) < 0) n.setXYZ(i, -nn.x, -nn.y, -nn.z);
  }
  fixWinding(g);
  g.computeVertexNormals();
  return { geo: g, tipY: cy, endX: HALF + L, style };
}

function sideTexture(spec) {
  const lv = spec.livery;
  return canvasTex(1024, 320, (g, W, H) => {
    const px = (x) => ((x + HALF) / (2 * HALF)) * W; // metres along car -> px
    const py = (y) => H - ((y - 1.0) / 2.0) * 256; // metres above rail -> px
    g.fillStyle = lv.roof;
    g.fillRect(0, 0, W, 64);
    g.fillStyle = lv.body;
    g.fillRect(0, 64, W, 256);
    // subtle panel shading
    const grd = g.createLinearGradient(0, 64, 0, H);
    grd.addColorStop(0, 'rgba(255,255,255,0.10)');
    grd.addColorStop(1, 'rgba(0,0,0,0.10)');
    g.fillStyle = grd;
    g.fillRect(0, 64, W, 256);
    g.fillStyle = '#44484c';
    g.fillRect(0, py(1.12), W, py(1.0) - py(1.12));
    const band = (y0, y1, c) => {
      g.fillStyle = c;
      g.fillRect(0, py(y1), W, py(y0) - py(y1));
    };
    const local = spec.type === 'local';
    if (spec.model === 'EMU800') {
      band(1.52, 1.78, lv.stripe);
      band(2.86, 2.92, lv.stripe);
    } else if (spec.model === 'EMU3000') {
      band(1.0, 1.3, '#c9ccd0');
      band(1.64, 1.74, lv.stripe);
    } else if (spec.model === 'TEMU2000') {
      band(1.55, 1.85, lv.stripe);
    } else {
      band(1.5, 1.8, lv.stripe);
      band(1.84, 1.9, lv.stripe2);
    }
    // windows
    const win = (x0, x1, y0 = 1.98, y1 = 2.75) => {
      g.fillStyle = lv.window;
      const r = 6;
      const X0 = px(x0), X1 = px(x1), Y0 = py(y1), Y1 = py(y0);
      g.beginPath();
      g.roundRect(X0, Y0, X1 - X0, Y1 - Y0, r);
      g.fill();
      g.fillStyle = 'rgba(140,170,190,0.22)';
      g.fillRect(X0 + 3, Y0 + 3, X1 - X0 - 6, (Y1 - Y0) * 0.3);
    };
    const doors = local ? [-6.3, 0, 6.3] : [8.2];
    const dw = local ? 1.3 : 1.0;
    if (local) {
      win(-9.4, -7.3);
      win(-5.3, -1.0);
      win(1.0, 5.3);
      win(7.3, 9.4);
    } else {
      for (let x = -9.2; x < 7.0; x += 1.85) win(x, x + 1.45, 2.0, 2.72);
    }
    for (const dx of doors) {
      const X0 = px(dx - dw / 2), X1 = px(dx + dw / 2);
      g.fillStyle = lv.door;
      g.fillRect(X0, py(2.95), X1 - X0, py(1.05) - py(2.95));
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      g.lineWidth = 2;
      g.strokeRect(X0, py(2.95), X1 - X0, py(1.05) - py(2.95));
      g.beginPath();
      g.moveTo((X0 + X1) / 2, py(2.95));
      g.lineTo((X0 + X1) / 2, py(1.05));
      g.stroke();
      g.fillStyle = lv.window;
      const inset = (X1 - X0) * 0.14;
      g.fillRect(X0 + inset, py(2.72), (X1 - X0) / 2 - inset * 1.3, py(2.0) - py(2.72));
      g.fillRect((X0 + X1) / 2 + inset * 0.3, py(2.72), (X1 - X0) / 2 - inset * 1.3, py(2.0) - py(2.72));
    }
  }, { key: `side-${spec.id}` });
}

function beam(x0, y0, z0, x1, y1, z1, t = 0.07) {
  const a = new THREE.Vector3(x0, y0, z0), b = new THREE.Vector3(x1, y1, z1);
  const len = a.distanceTo(b);
  const g = new THREE.BoxGeometry(len, t, t);
  const m = new THREE.Matrix4();
  const dir = b.clone().sub(a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
  m.compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g.toNonIndexed();
}

const shared = new Map();
function sharedParts(spec, env) {
  if (shared.has(spec.id)) return shared.get(spec.id);
  const side = sideTexture(spec);
  const bodyMat = new THREE.MeshStandardMaterial({ map: side, metalness: 0.35, roughness: 0.32, envMap: env, envMapIntensity: 0.8 });
  const nose = noseGeometry(spec);
  const noseMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.3, envMap: env, envMapIntensity: 0.9 });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x2c2e30 });
  const greyMat = new THREE.MeshLambertMaterial({ color: 0x8e9295 });

  // bogie
  const bparts = [new THREE.BoxGeometry(2.7, 0.32, 2.1).translate(0, 0.62, 0).toNonIndexed()];
  for (const x of [-1.05, 1.05]) {
    for (const z of [-0.6, 0.6]) {
      bparts.push(new THREE.CylinderGeometry(0.43, 0.43, 0.13, 14).rotateX(Math.PI / 2).translate(x, 0.43, z).toNonIndexed());
    }
    bparts.push(new THREE.BoxGeometry(0.3, 0.28, 2.3).translate(x, 0.5, 0).toNonIndexed());
  }
  const bogie = mergeGeometries(bparts);
  const under = new THREE.BoxGeometry(9, 0.5, 2.3).translate(0, 0.78, 0);
  const ac = new THREE.BoxGeometry(3.2, 0.34, 1.9).translate(0, 3.72, 0);
  const endF = endCapGeometry(HALF, 1);
  const endR = endCapGeometry(-HALF, -1);
  // pantograph (single arm)
  const pparts = [
    new THREE.BoxGeometry(1.6, 0.14, 1.3).translate(0, 3.74, 0).toNonIndexed(),
    beam(-0.7, 3.8, 0, 0.55, 4.6, 0, 0.09),
    beam(0.55, 4.6, 0, -0.5, 5.24, 0, 0.07),
    new THREE.BoxGeometry(0.28, 0.08, 1.7).translate(-0.5, 5.28, 0).toNonIndexed(),
  ];
  const panto = mergeGeometries(pparts);
  const lightGeo = new THREE.PlaneGeometry(0.34, 0.16).rotateY(Math.PI / 2);
  const res = {
    body: bodyGeometry(), bodyMat, nose, noseMat, darkMat, greyMat, bogie, under, ac, endF, endR, panto, lightGeo,
  };
  shared.set(spec.id, res);
  return res;
}

export class TrainModel {
  constructor(spec, { env, dest = '', lights = true } = {}) {
    this.spec = spec;
    this.group = new THREE.Group();
    this.cars = [];
    this.noseLen = spec.noseLen;
    const P = sharedParts(spec, env);
    const n = spec.cars;
    this.headMat = new THREE.MeshBasicMaterial({ color: 0xfff6e0, toneMapped: false });
    this.tailMat = new THREE.MeshBasicMaterial({ color: 0xff1a10, toneMapped: false });
    this.offMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
    const pantoCars = n >= 12 ? [2, 6, 9] : [1, n - 3];
    for (let i = 0; i < n; i++) {
      const car = new THREE.Group();
      car.rotation.order = 'YZX';
      const body = new THREE.Mesh(P.body, P.bodyMat);
      body.castShadow = true;
      car.add(body);
      const isHead = i === 0, isTail = i === n - 1;
      if (isHead || isTail) {
        const nose = new THREE.Mesh(P.nose.geo, P.noseMat);
        nose.castShadow = true;
        const holder = new THREE.Group();
        holder.add(nose);
        const endX = P.nose.endX;
        const sz = P.nose.style.sz(1), sy = P.nose.style.sy(1);
        for (const zz of [-0.95, 0.95]) {
          const l = new THREE.Mesh(P.lightGeo, isHead ? this.headMat : this.tailMat);
          l.position.set(endX + 0.03, 1.0 + 0.45 * sy, zz * sz);
          holder.add(l);
        }
        if (dest && spec.model !== 'TEMU2000') {
          const dm = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.19).rotateY(Math.PI / 2), new THREE.MeshBasicMaterial({ map: destTexture(dest), toneMapped: false }));
          dm.position.set(endX + 0.04, 1.0 + 2.28 * sy, 0);
          holder.add(dm);
        }
        if (isTail) holder.rotation.y = Math.PI;
        car.add(holder);
      }
      if (!isHead) car.add(new THREE.Mesh(P.endF, P.darkMat));
      if (!isTail) car.add(new THREE.Mesh(P.endR, P.darkMat));
      if (n === 1) {
        // single-car special case not used
      }
      for (const bx of [-6.9, 6.9]) {
        const b = new THREE.Mesh(P.bogie, P.darkMat);
        b.position.x = bx;
        car.add(b);
      }
      car.add(new THREE.Mesh(P.under, P.darkMat));
      for (const ax of [-4, 4]) {
        const a = new THREE.Mesh(P.ac, P.greyMat);
        a.position.x = ax;
        car.add(a);
      }
      if (pantoCars.includes(i)) {
        const p = new THREE.Mesh(P.panto, P.darkMat);
        p.position.x = -6.4;
        car.add(p);
      }
      this.group.add(car);
      this.cars.push(car);
    }
    this.tmpA = {};
    this.tmpB = {};
  }

  // Position cars along the route. dir=+1 runs towards increasing s.
  place(route, sFront, dir = 1, d = 0) {
    const A = this.tmpA, B = this.tmpB;
    const tiltMul = this.spec.tilt ? 1.8 : 1;
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      const sc = sFront - dir * (this.noseLen + HALF + 0.2 + i * 20);
      route.frame(sc + dir * 6.9, d, A);
      route.frame(sc - dir * 6.9, d, B);
      car.position.set((A.x + B.x) * 0.5, (A.y + B.y) * 0.5, (A.z + B.z) * 0.5);
      const yaw = Math.atan2(A.z - B.z, A.x - B.x);
      car.rotation.y = -yaw;
      car.rotation.z = Math.atan2(A.y - B.y, 13.8);
      const k = route.curvAt(sc) * dir;
      car.rotation.x = clamp(k * 38 * tiltMul, -0.09, 0.09);
    }
  }

  setHeadlights(on) {
    this.headMat.color.set(on ? 0xfff6e0 : 0x333333);
  }

  dispose() {
    this.group.removeFromParent();
  }
}

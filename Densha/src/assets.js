// Shared procedural textures, geometries and materials.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RNG } from './util.js';

const texCache = new Map();

function canvasTex(w, h, draw, { repeat = false, srgb = true, key } = {}) {
  if (key && texCache.has(key)) return texCache.get(key);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  if (key) texCache.set(key, t);
  return t;
}

// Triangular prism: base width w along x at y=0, apex height h, length len along z (centred).
export function prismGeo(w, h, len) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(0, h);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false });
  g.translate(0, 0, -len / 2);
  return g;
}

const FONT_ZH ='"Noto Sans TC", "Microsoft JhengHei", "PingFang TC", sans-serif';

function noiseFill(g, w, h, base, amp, seed, size = 1) {
  const rng = new RNG(seed);
  const img = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const n = (rng.next() - 0.5) * amp;
    img.data[i * 4] = Math.max(0, Math.min(255, base[0] + n * (base[3] || 1)));
    img.data[i * 4 + 1] = Math.max(0, Math.min(255, base[1] + n));
    img.data[i * 4 + 2] = Math.max(0, Math.min(255, base[2] + n));
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

export function createAssets(renderer) {
  const A = {};
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // ---------- textures ----------
  A.groundDetail = canvasTex(256, 256, (g, w, h) => {
    const rng = new RNG(7);
    g.fillStyle = '#d8d8d8';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {
      const v = 170 + rng.next() * 85;
      g.fillStyle = `rgb(${v},${v},${v})`;
      const s = 1 + rng.next() * 3;
      g.fillRect(rng.next() * w, rng.next() * h, s, s);
    }
  }, { repeat: true, srgb: false });
  A.groundDetail.anisotropy = maxAniso;

  A.ballast = canvasTex(128, 128, (g, w, h) => {
    const rng = new RNG(11);
    g.fillStyle = '#6e6960';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 1400; i++) {
      const v = 70 + rng.next() * 110;
      g.fillStyle = `rgb(${v + 6},${v},${v - 8})`;
      g.beginPath();
      g.arc(rng.next() * w, rng.next() * h, 1 + rng.next() * 2.2, 0, 6.28);
      g.fill();
    }
  }, { repeat: true });
  A.ballast.anisotropy = maxAniso;

  A.concrete = canvasTex(128, 128, (g, w, h) => {
    noiseFill(g, w, h, [168, 166, 160], 26, 3);
    g.strokeStyle = 'rgba(60,60,60,0.35)';
    g.lineWidth = 2;
    g.strokeRect(0, 0, w, h);
  }, { repeat: true });

  A.tunnelTex = canvasTex(128, 256, (g, w, h) => {
    noiseFill(g, w, h, [96, 93, 88], 14, 5);
    const rng = new RNG(51);
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(20,18,15,${0.08 + rng.next() * 0.12})`;
      g.beginPath();
      g.ellipse(rng.next() * w, rng.next() * h, 4 + rng.next() * 16, 8 + rng.next() * 30, 0, 0, 6.28);
      g.fill();
    }
    g.fillStyle = 'rgba(15,15,15,0.7)';
    g.fillRect(0, 0, w, 3);
  }, { repeat: true });

  A.road = canvasTex(64, 256, (g, w, h) => {
    noiseFill(g, w, h, [70, 70, 72], 18, 9);
    g.fillStyle = '#e8e8e0';
    g.fillRect(2, 0, 3, h);
    g.fillRect(w - 5, 0, 3, h);
    g.fillStyle = '#e8c020';
    for (let y = 0; y < h; y += 64) g.fillRect(w / 2 - 1.5, y, 3, 36);
  }, { repeat: true });

  // building facade: 4 bays x 4 floors, with iron window grilles
  const facade = (lit) =>
    canvasTex(512, 512, (g, w, h) => {
      const rng = new RNG(lit ? 21 : 20);
      g.fillStyle = lit ? '#000' : '#e6e3dc';
      g.fillRect(0, 0, w, h);
      if (!lit) {
        for (let i = 0; i < 900; i++) {
          g.fillStyle = `rgba(0,0,0,${rng.next() * 0.05})`;
          g.fillRect(rng.next() * w, rng.next() * h, 6, 6);
        }
      }
      const bw = w / 4, fh = h / 4;
      const litRng = new RNG(99);
      for (let fx = 0; fx < 4; fx++) {
        for (let fy = 0; fy < 4; fy++) {
          const x = fx * bw, y = fy * fh;
          const wx = x + bw * 0.14, wy = y + fh * 0.2, ww = bw * 0.72, wh = fh * 0.52;
          if (lit) {
            if (litRng.next() < 0.45) {
              const warm = litRng.next() < 0.7;
              g.fillStyle = warm ? '#ffcf7a' : '#dff2ff';
              g.fillRect(wx, wy, ww, wh);
            }
            continue;
          }
          // window
          g.fillStyle = '#39434b';
          g.fillRect(wx, wy, ww, wh);
          g.fillStyle = 'rgba(160,190,210,0.35)';
          g.fillRect(wx, wy, ww, wh * 0.35);
          // iron grille 鐵窗
          g.strokeStyle = '#6d6a64';
          g.lineWidth = 3;
          g.strokeRect(wx - 4, wy - 4, ww + 8, wh + 8);
          g.lineWidth = 1.5;
          for (let k = 1; k < 7; k++) {
            g.beginPath();
            g.moveTo(wx + (ww * k) / 7, wy - 4);
            g.lineTo(wx + (ww * k) / 7, wy + wh + 4);
            g.stroke();
          }
          // AC unit
          if (rng.next() < 0.5) {
            g.fillStyle = '#d9d9d4';
            g.fillRect(wx + ww * 0.62, wy + wh + 8, ww * 0.34, fh * 0.14);
          }
          // floor slab line
          g.fillStyle = 'rgba(0,0,0,0.12)';
          g.fillRect(x, y + fh - 6, bw, 6);
        }
      }
    }, { repeat: true });
  A.facade = facade(false);
  A.facadeLit = facade(true);

  A.corrugated = canvasTex(64, 64, (g, w, h) => {
    for (let x = 0; x < w; x += 4) {
      g.fillStyle = x % 8 === 0 ? '#e0e0e0' : '#b8b8b8';
      g.fillRect(x, 0, 4, h);
    }
  }, { repeat: true });

  // ---------- materials ----------
  A.mat = {};
  A.mat.terrain = new THREE.MeshLambertMaterial({ vertexColors: true, map: A.groundDetail });
  A.mat.ballast = new THREE.MeshLambertMaterial({ map: A.ballast });
  A.mat.sleeper = new THREE.MeshLambertMaterial({ color: 0x8d8a84 });
  A.mat.rail = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.7, roughness: 0.38 });
  A.mat.concrete = new THREE.MeshLambertMaterial({ map: A.concrete });
  A.mat.concreteDark = new THREE.MeshLambertMaterial({ color: 0x77736c });
  A.mat.platform = new THREE.MeshLambertMaterial({ color: 0xb9b5ad, map: A.concrete });
  A.mat.yellow = new THREE.MeshLambertMaterial({ color: 0xf2c200 });
  A.mat.white = new THREE.MeshLambertMaterial({ color: 0xf2f2ee });
  A.mat.steel = new THREE.MeshLambertMaterial({ color: 0x7c8388 });
  A.mat.darkSteel = new THREE.MeshLambertMaterial({ color: 0x3b3f43 });
  A.mat.wire = new THREE.LineBasicMaterial({ color: 0x1e1e1e });
  A.mat.tunnel = new THREE.MeshLambertMaterial({ map: A.tunnelTex, side: THREE.DoubleSide });
  A.mat.tunnelLamp = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
  A.mat.road = new THREE.MeshLambertMaterial({ map: A.road });
  A.mat.water = new THREE.MeshStandardMaterial({ color: 0x5f7f86, roughness: 0.12, metalness: 0.05 });
  A.mat.building = new THREE.MeshLambertMaterial({
    map: A.facade, emissiveMap: A.facadeLit, emissive: 0xffffff, emissiveIntensity: 0,
  });
  A.mat.roof = new THREE.MeshLambertMaterial({ color: 0x9d9a94 });
  A.mat.shed = new THREE.MeshLambertMaterial({ map: A.corrugated });
  A.mat.tank = new THREE.MeshStandardMaterial({ color: 0xd8dde0, metalness: 0.8, roughness: 0.3 });
  A.mat.factory = new THREE.MeshLambertMaterial({ map: A.corrugated });
  const rows = (wet) =>
    canvasTex(128, 128, (g, w, h) => {
      g.fillStyle = wet ? '#b8c4c8' : '#d8d8d8';
      g.fillRect(0, 0, w, h);
      g.fillStyle = wet ? 'rgba(90,140,60,0.55)' : 'rgba(255,255,255,0.35)';
      for (let x = 0; x < w; x += 8) g.fillRect(x, 0, wet ? 2 : 4, h);
      if (!wet) {
        g.fillStyle = 'rgba(0,0,0,0.12)';
        for (let x = 4; x < w; x += 8) g.fillRect(x, 0, 2, h);
      }
    });
  A.mat.paddy = new THREE.MeshLambertMaterial({ color: 0xffffff, map: rows(false) });
  A.mat.paddyWet = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.14, metalness: 0.15, map: rows(true) });
  A.mat.trunk = new THREE.MeshLambertMaterial({ color: 0x6b5a45 });
  A.mat.palmTrunk = new THREE.MeshLambertMaterial({ color: 0x9a9587 });
  A.mat.leaf = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  A.mat.person = new THREE.MeshLambertMaterial({ color: 0xffffff });
  A.mat.head = new THREE.MeshLambertMaterial({ color: 0x2a2320 });
  A.mat.canopy = new THREE.MeshLambertMaterial({ color: 0x3c6d9e });
  A.mat.wood = new THREE.MeshLambertMaterial({ color: 0x7a5236 });
  A.mat.tileRoof = new THREE.MeshLambertMaterial({ color: 0x4d5257 });
  A.mat.templeRed = new THREE.MeshLambertMaterial({ color: 0xb3261e });
  A.mat.templeRoof = new THREE.MeshLambertMaterial({ color: 0xd9822b });
  A.mat.turbine = new THREE.MeshLambertMaterial({ color: 0xf0f2f2 });
  A.mat.car = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.4 });
  A.mat.glass = new THREE.MeshStandardMaterial({ color: 0x1a2229, roughness: 0.1, metalness: 0.5 });
  A.mat.lampOff = new THREE.MeshLambertMaterial({ color: 0x1b1b1b });
  A.mat.signalHead = new THREE.MeshLambertMaterial({ color: 0x151515 });
  A.mat.stripe = new THREE.MeshLambertMaterial({
    map: canvasTex(64, 64, (g, w, h) => {
      g.fillStyle = '#f2c200';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#111';
      for (let i = -2; i < 4; i++) {
        g.beginPath();
        g.moveTo(i * 32, 0);
        g.lineTo(i * 32 + 16, 0);
        g.lineTo(i * 32 + 16 + 64, h);
        g.lineTo(i * 32 + 64, h);
        g.fill();
      }
    }, { repeat: true }),
  });
  A.mat.lightRed = new THREE.MeshBasicMaterial({ color: 0xff2a1a, toneMapped: false });
  A.mat.lampWarm = new THREE.MeshBasicMaterial({ color: 0xfff0d0 });
  A.nightMats = [A.mat.building, A.mat.tunnelLamp, A.mat.lampWarm];

  // ---------- geometries ----------
  A.geo = {};
  A.geo.unitBox = new THREE.BoxGeometry(1, 1, 1);
  A.geo.unitBoxBase = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  A.geo.sleeper = new THREE.BoxGeometry(0.24, 0.18, 2.0);
  A.geo.cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 10).translate(0, 0.5, 0);

  // buildings: box with UVs scaled to facade tiles (tile = 4 bays of 3 m x 4 floors of 3.2 m)
  A.buildingGeo = (w, h, d) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(0, h / 2, 0);
    const uv = g.attributes.uv;
    const tileW = 12, tileH = 12.8;
    // face order: +x, -x, +y, -y, +z, -z (4 verts each)
    const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) {
      const [fw, fh] = dims[f];
      for (let v = 0; v < 4; v++) {
        const i = f * 4 + v;
        if (f === 2 || f === 3) uv.setXY(i, uv.getX(i) * 0.02, uv.getY(i) * 0.02);
        else uv.setXY(i, uv.getX(i) * (fw / tileW), uv.getY(i) * (fh / tileH));
      }
    }
    // groups: roof uses material 1
    g.clearGroups();
    g.addGroup(0, 12, 0);
    g.addGroup(12, 6, 1);
    g.addGroup(18, 6, 0);
    g.addGroup(24, 12, 0);
    return g;
  };
  A.townhouse = [2, 3, 4, 5].map((f) => A.buildingGeo(5.5, f * 3.2 + 0.6, 13));
  A.apartment = [7, 10, 13].map((f) => A.buildingGeo(20, f * 3.2 + 0.8, 15));

  // rooftop iron shed 鐵皮加蓋 (unit width/depth, height 2.6)
  {
    const walls = new THREE.BoxGeometry(1, 2.0, 1).translate(0, 1.0, 0);
    const roof = prismGeo(1.1, 0.6, 1.04).translate(0, 2.0, 0);
    A.shedGeo = mergeGeometries([walls.toNonIndexed(), roof]);
    A.shedGeo.computeVertexNormals();
  }
  A.tankGeo = new THREE.CylinderGeometry(0.55, 0.55, 1.4, 10).rotateZ(Math.PI / 2).translate(0, 0.9, 0);

  // factory with low gable roof
  {
    const body = new THREE.BoxGeometry(30, 7, 40).translate(0, 3.5, 0);
    const roof = prismGeo(31, 2.4, 40.6).translate(0, 7, 0);
    A.factoryGeo = mergeGeometries([body.toNonIndexed(), roof]);
    A.factoryGeo.computeVertexNormals();
  }
  // rural brick house with tile gable roof (long axis along x)
  A.houseBody = new THREE.BoxGeometry(12, 3.4, 7).translate(0, 1.7, 0);
  A.houseRoof = prismGeo(8, 2.2, 12.8).rotateY(Math.PI / 2).translate(0, 3.4, 0);

  // trees
  A.trunkGeo = new THREE.CylinderGeometry(0.12, 0.2, 1, 5).translate(0, 0.5, 0);
  A.canopyGeo = new THREE.IcosahedronGeometry(1, 1);
  A.forestGeo = new THREE.IcosahedronGeometry(1, 0).translate(0, 0.6, 0);
  A.palmTrunkGeo = new THREE.CylinderGeometry(0.1, 0.14, 1, 5).translate(0, 0.5, 0);
  {
    // betel-nut palm crown: drooping fronds
    const parts = [];
    for (let i = 0; i < 7; i++) {
      const f = new THREE.ConeGeometry(0.28, 3.2, 3, 1);
      f.translate(0, 1.6, 0);
      f.rotateZ(1.1 + (i % 2) * 0.35);
      f.rotateY((i / 7) * Math.PI * 2);
      parts.push(f.toNonIndexed());
    }
    const top = new THREE.ConeGeometry(0.25, 1.6, 4).translate(0, 0.7, 0);
    parts.push(top.toNonIndexed());
    A.palmCrownGeo = mergeGeometries(parts);
    A.palmCrownGeo.computeVertexNormals();
  }
  A.paddyGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, -0.5, 0);
  A.personGeo = new THREE.CapsuleGeometry(0.2, 1.0, 3, 6).translate(0, 0.72, 0);
  A.headGeo = new THREE.SphereGeometry(0.12, 6, 5).translate(0, 1.56, 0);

  // catenary mast with cantilever towards +z (track side)
  const mast = (sign) => {
    const parts = [
      new THREE.BoxGeometry(0.3, 7.8, 0.3).translate(0, 3.9, 0),
      new THREE.BoxGeometry(0.1, 0.1, 3.9).translate(0, 6.6, sign * 1.95),
      new THREE.BoxGeometry(0.08, 0.08, 3.4).rotateX(sign * 0.36).translate(0, 6.0, sign * 1.7),
      new THREE.BoxGeometry(0.2, 0.3, 0.2).translate(0, 6.6, sign * 3.8),
    ];
    const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
    return g;
  };
  A.mastL = mast(1);
  A.mastR = mast(-1);
  A.wallGeo = new THREE.BoxGeometry(5, 2.2, 0.22).translate(0, 1.1, 0);

  return A;
}

// ---------------- text / sign textures ----------------

export function stationBoardTexture(st) {
  const key = `sb-${st.zh}`;
  return canvasTex(768, 256, (g, w, h) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#1b4f93';
    g.fillRect(0, 0, w, 14);
    g.fillRect(0, h - 58, w, 58);
    g.fillStyle = '#111';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `900 104px ${FONT_ZH}`;
    g.fillText(st.zh, w / 2, 82);
    g.font = `600 34px "Segoe UI", Arial, sans-serif`;
    g.fillText(st.en, w / 2, 156);
    g.fillStyle = '#fff';
    g.font = `700 30px ${FONT_ZH}`;
    g.textAlign = 'left';
    if (st.prev) g.fillText(`◀ ${st.prev.zh} ${st.prev.en}`, 18, h - 29);
    g.textAlign = 'right';
    if (st.next) g.fillText(`${st.next.zh} ${st.next.en} ▶`, w - 18, h - 29);
  }, { key });
}

export function buildingSignTexture(st) {
  const key = `bs-${st.zh}`;
  return canvasTex(512, 128, (g, w, h) => {
    g.fillStyle = st.wooden ? '#3a2a1c' : '#f4f4f0';
    g.fillRect(0, 0, w, h);
    g.fillStyle = st.wooden ? '#f0e6d0' : '#1b4f93';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `900 78px ${FONT_ZH}`;
    g.fillText(`${st.zh}車站`, w / 2, h / 2 + 4);
  }, { key });
}

export function signTexture(kind, v) {
  const key = `sign-${kind}-${v}`;
  return canvasTex(128, 160, (g, w, h) => {
    const num = (color, y = 96, size = 70) => {
      g.fillStyle = color;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `900 ${size}px "Arial Black", Arial, sans-serif`;
      g.fillText(String(v), w / 2, y);
    };
    const label = (text, color, y = 28, size = 30) => {
      g.fillStyle = color;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `900 ${size}px ${FONT_ZH}`;
      g.fillText(text, w / 2, y);
    };
    if (kind === 'limit') {
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
      g.lineWidth = 10; g.strokeStyle = '#d11'; g.strokeRect(5, 5, w - 10, h - 10);
      label('限速', '#d11'); num('#111');
    } else if (kind === 'warn') {
      g.fillStyle = '#ffd400'; g.fillRect(0, 0, w, h);
      g.lineWidth = 8; g.strokeStyle = '#111'; g.strokeRect(4, 4, w - 8, h - 8);
      label('預告', '#111'); num('#111');
    } else if (kind === 'release') {
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
      g.lineWidth = 10; g.strokeStyle = '#1a8a3a'; g.strokeRect(5, 5, w - 10, h - 10);
      label('解除', '#1a8a3a'); num('#111');
    } else if (kind === 'slow' || kind === 'slowwarn') {
      g.fillStyle = kind === 'slow' ? '#ffd400' : '#fff'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#111';
      for (let x = -40; x < w; x += 32) { g.save(); g.translate(x, 0); g.fillRect(0, h - 22, 16, 22); g.restore(); }
      label(kind === 'slow' ? '慢行' : '慢行預告', '#111', 30, kind === 'slow' ? 34 : 24); num('#111', 90);
    } else if (kind === 'slowend') {
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
      g.lineWidth = 10; g.strokeStyle = '#111'; g.strokeRect(5, 5, w - 10, h - 10);
      label('慢行', '#111', 50, 36); label('解除', '#1a8a3a', 104, 36);
    } else if (kind === 'whistle') {
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
      g.lineWidth = 8; g.strokeStyle = '#111'; g.strokeRect(4, 4, w - 8, h - 8);
      label('鳴', '#111', 80, 92);
    } else if (kind === 'stop') {
      g.fillStyle = '#ffd400'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#111'; g.fillRect(8, 8, w - 16, 44);
      label('停車', '#ffd400', 30, 30); num('#111', 106, 76);
    } else if (kind === 'crossing') {
      g.fillStyle = 'rgba(0,0,0,0)'; g.clearRect(0, 0, w, h);
      g.save(); g.translate(w / 2, h / 2);
      for (const a of [0.7, -0.7]) {
        g.save(); g.rotate(a);
        g.fillStyle = '#fff'; g.fillRect(-70, -13, 140, 26);
        g.strokeStyle = '#d11'; g.lineWidth = 6; g.strokeRect(-70, -13, 140, 26);
        g.restore();
      }
      g.restore();
    }
  }, { key });
}

export function destTexture(text) {
  return canvasTex(256, 48, (g, w, h) => {
    g.fillStyle = '#050505';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#ff9a1f';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 32px ${FONT_ZH}`;
    g.fillText(text, w / 2, h / 2 + 2);
  }, { key: `dest-${text}` });
}

export { canvasTex };

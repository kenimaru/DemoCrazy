// Sky dome, lighting, fog, sea, distant mountain backdrop, clouds and stars for each time of day.

import * as THREE from 'three';
import { canvasTex } from './assets.js';
import { RNG, Noise2D, clamp, lerp } from './util.js';

export const PRESETS = {
  day: {
    top: 0x3f7fce, horizon: 0xcfdde6, bottom: 0x93a3a6, fog: 0xc4d3db, fogNear: 250, fogFar: 3600,
    sunElev: 50, sunAz: 35, sun: 0xfff2de, sunI: 3.1, hemiSky: 0xcfe2ff, hemiGround: 0x5d5343, hemiI: 1.35,
    ring: 0x8fa3b2, cloud: 0xffffff, exposure: 0.95, night: false, stars: 0,
  },
  dusk: {
    top: 0x28467e, horizon: 0xf0a266, bottom: 0x6a5a58, fog: 0xd29c7c, fogNear: 200, fogFar: 3000,
    sunElev: 5, sunAz: 250, sun: 0xffa060, sunI: 2.2, hemiSky: 0x9fa6d0, hemiGround: 0x4a3526, hemiI: 0.75,
    ring: 0x6f5f72, cloud: 0xffbe96, exposure: 1.05, night: false, stars: 0.15,
  },
  night: {
    top: 0x02050e, horizon: 0x18233c, bottom: 0x07090e, fog: 0x121b2b, fogNear: 60, fogFar: 1700,
    sunElev: 38, sunAz: 140, sun: 0x9db6ff, sunI: 0.32, hemiSky: 0x40527e, hemiGround: 0x16161c, hemiI: 0.42,
    ring: 0x121a2a, cloud: 0x263048, exposure: 1.25, night: true, stars: 1,
  },
};

function ringTexture(seed, gap) {
  return canvasTex(2048, 256, (g, w, h) => {
    const n = new Noise2D(seed);
    g.clearRect(0, 0, w, h);
    const layers = [
      { amp: 0.55, base: 0.25, f: 6, col: [200, 210, 220] },
      { amp: 0.45, base: 0.12, f: 11, col: [150, 165, 180] },
    ];
    for (const L of layers) {
      g.fillStyle = `rgb(${L.col[0]},${L.col[1]},${L.col[2]})`;
      g.beginPath();
      g.moveTo(0, h);
      for (let x = 0; x <= w; x += 4) {
        const u = x / w;
        let m = L.base + L.amp * (0.5 + 0.5 * n.fbm(Math.cos(u * Math.PI * 2) * L.f * 0.3 + L.f, Math.sin(u * Math.PI * 2) * L.f * 0.3, 4));
        if (gap) {
          const du = Math.abs(u - 0.5);
          m *= clamp((du - 0.14) / 0.1, 0, 1);
        }
        g.lineTo(x, h - m * h);
      }
      g.lineTo(w, h);
      g.closePath();
      g.fill();
    }
    // haze towards the base
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(1, 'rgba(255,255,255,0.55)');
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  }, { key: `ring-${seed}-${gap}` });
}

function cloudTexture(i) {
  return canvasTex(256, 128, (g, w, h) => {
    const rng = new RNG(100 + i);
    for (let k = 0; k < 26; k++) {
      const x = w * (0.2 + rng.next() * 0.6), y = h * (0.45 + rng.next() * 0.25);
      const r = 18 + rng.next() * 34;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(255,255,255,0.55)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, w, h);
    }
  }, { key: `cloud-${i}` });
}

function waterNormal() {
  const size = 256;
  const n = new Noise2D(77);
  const hgt = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = (x / size) * Math.PI * 2, v = (y / size) * Math.PI * 2;
      hgt[y * size + x] = n.fbm(Math.cos(u) * 2 + 5, Math.sin(u) * 2 + Math.cos(v) * 2 + Math.sin(v) * 0.5, 4);
    }
  return canvasTex(size, size, (g) => {
    const img = g.createImageData(size, size);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const hx = hgt[y * size + ((x + 1) % size)] - hgt[y * size + ((x - 1 + size) % size)];
        const hy = hgt[((y + 1) % size) * size + x] - hgt[((y - 1 + size) % size) * size + x];
        const i = (y * size + x) * 4;
        img.data[i] = 128 - hx * 300;
        img.data[i + 1] = 128 - hy * 300;
        img.data[i + 2] = 255;
        img.data[i + 3] = 255;
      }
    g.putImageData(img, 0, 0);
  }, { repeat: true, srgb: false, key: 'waternormal' });
}

export class Environment {
  constructor(scene, renderer, route, timeKey) {
    this.scene = scene;
    this.renderer = renderer;
    this.route = route;
    const P = (this.P = PRESETS[timeKey]);
    this.objects = [];
    const add = (o) => {
      scene.add(o);
      this.objects.push(o);
      return o;
    };

    const elev = THREE.MathUtils.degToRad(P.sunElev), az = THREE.MathUtils.degToRad(P.sunAz);
    this.sunDir = new THREE.Vector3(Math.cos(elev) * Math.cos(az), Math.sin(elev), Math.cos(elev) * Math.sin(az));

    // sky dome
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        top: { value: new THREE.Color(P.top) },
        horizon: { value: new THREE.Color(P.horizon) },
        bottom: { value: new THREE.Color(P.bottom) },
        sunDir: { value: this.sunDir },
        sunColor: { value: new THREE.Color(P.sun) },
        sunStrength: { value: P.night ? 0.25 : 1.0 },
      },
      vertexShader: `varying vec3 vDir;
        void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunStrength;
        varying vec3 vDir;
        void main(){
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = h > 0.0 ? mix(horizon, top, pow(clamp(h,0.0,1.0), 0.5)) : mix(horizon, bottom, clamp(-h*6.0,0.0,1.0));
          float sd = max(dot(d, normalize(sunDir)), 0.0);
          col += sunColor * sunStrength * (pow(sd, 1200.0) * 8.0 + pow(sd, 60.0) * 0.25 + pow(sd, 6.0) * 0.12);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.sky = add(new THREE.Mesh(new THREE.SphereGeometry(9000, 32, 16), this.skyMat));
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;

    // environment map for reflective materials
    const skyScene = new THREE.Scene();
    skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), this.skyMat));
    const pm = new THREE.PMREMGenerator(renderer);
    this.envRT = pm.fromScene(skyScene, 0, 0.1, 1000);
    pm.dispose();
    scene.environment = this.envRT.texture;
    scene.environmentIntensity = P.night ? 0.4 : 1.0;

    // lights
    this.hemi = add(new THREE.HemisphereLight(P.hemiSky, P.hemiGround, P.hemiI));
    this.sun = new THREE.DirectionalLight(P.sun, P.sunI);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -110; sc.right = 110; sc.top = 110; sc.bottom = -110; sc.near = 1; sc.far = 1200;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    add(this.sun);
    add(this.sun.target);

    scene.fog = new THREE.Fog(P.fog, P.fogNear, P.fogFar);
    scene.background = new THREE.Color(P.fog);

    // distant mountain ring
    const gap = route.hasOcean;
    this.ringMat = new THREE.MeshBasicMaterial({
      map: ringTexture(route.seed % 97, gap), transparent: false, alphaTest: 0.35, fog: false, color: P.ring, side: THREE.BackSide,
    });
    const rg = new THREE.CylinderGeometry(7000, 7000, 1, 64, 1, true).translate(0, 0.5, 0);
    this.ring = add(new THREE.Mesh(rg, this.ringMat));
    this.ring.frustumCulled = false;
    this.ringH = 300;

    // sea
    if (route.hasOcean) {
      const wn = waterNormal();
      wn.repeat.set(700, 700);
      this.seaTex = wn;
      this.seaMat = new THREE.MeshStandardMaterial({
        color: P.night ? 0x0a1a28 : 0x1e5877, roughness: 0.16, metalness: 0.05, normalMap: wn, normalScale: new THREE.Vector2(0.6, 0.6),
      });
      this.sea = add(new THREE.Mesh(new THREE.PlaneGeometry(28000, 28000).rotateX(-Math.PI / 2), this.seaMat));
      this.sea.position.y = route.seaY;
      this.sea.receiveShadow = false;
    } else {
      this.groundMat = new THREE.MeshLambertMaterial({ color: 0x4d5a3a });
      this.ground = add(new THREE.Mesh(new THREE.PlaneGeometry(28000, 28000).rotateX(-Math.PI / 2), this.groundMat));
    }

    // clouds
    this.clouds = [];
    const rng = new RNG(route.seed ^ 0xc10d);
    const nClouds = P.night ? 10 : 28;
    for (let i = 0; i < nClouds; i++) {
      const m = new THREE.SpriteMaterial({ map: cloudTexture(i % 6), color: P.cloud, fog: false, depthWrite: false, transparent: true, opacity: 0.9 });
      const sp = add(new THREE.Sprite(m));
      const s = rng.range(700, 1600);
      sp.scale.set(s, s * 0.5, 1);
      sp.userData.off = new THREE.Vector3(rng.range(-6500, 6500), rng.range(700, 1500), rng.range(-6500, 6500));
      this.clouds.push(sp);
    }

    // stars
    if (P.stars > 0) {
      const pts = [];
      for (let i = 0; i < 1500; i++) {
        const u = rng.next() * 2 - 1, t = rng.next() * Math.PI * 2;
        const y = Math.abs(u);
        const r = Math.sqrt(1 - y * y);
        pts.push(Math.cos(t) * r * 8500, y * 8500, Math.sin(t) * r * 8500);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      this.stars = add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: P.stars, depthWrite: false })));
      this.stars.frustumCulled = false;
    }

    renderer.toneMappingExposure = P.exposure;
    this.tunnel = 0;
  }

  setNightMaterials(assets) {
    const on = this.P.night;
    assets.mat.building.emissiveIntensity = on ? 0.9 : 0;
    for (const m of [assets.mat.platform, assets.mat.yellow]) {
      m.emissive.set(on ? 0x3a352c : 0x000000);
    }
    assets.mat.tunnelLamp.color.set(on ? 0xffd9a0 : 0xffd9a0);
    assets.mat.lampWarm.color.set(on ? 0xfff0d0 : 0xe8e4d8);
  }

  update(dt, camera, focus, trackY, heading, inTunnel, params, time) {
    const P = this.P;
    const cp = camera.position;
    this.sky.position.copy(cp);
    this.ring.position.set(cp.x, trackY - 60, cp.z);
    if (this.stars) this.stars.position.copy(cp);
    // backdrop height follows scenery theme
    if (params) {
      const target = clamp(120 + Math.max(params.mAL, params.mAR) * 1.1, 140, 1150);
      this.ringH += (target - this.ringH) * Math.min(1, dt * 0.3);
    }
    this.ring.scale.y = this.ringH;
    if (this.route.hasOcean) {
      const ox = -Math.sin(heading) * this.route.oceanSide, oz = Math.cos(heading) * this.route.oceanSide;
      const target = Math.atan2(-ox, -oz);
      let diff = target - this.ring.rotation.y;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.ring.rotation.y += diff * Math.min(1, dt * 0.8);
      this.sea.position.x = cp.x;
      this.sea.position.z = cp.z;
      this.seaTex.offset.set(cp.x / 40 + time * 0.004, -cp.z / 40 + time * 0.003);
    } else {
      this.ground.position.set(cp.x, trackY - 8, cp.z);
    }
    for (const c of this.clouds) {
      const o = c.userData.off;
      o.x += dt * 4;
      let dx = ((o.x - cp.x * 0.3) % 13000 + 13000) % 13000 - 6500;
      let dz = ((o.z - cp.z * 0.3) % 13000 + 13000) % 13000 - 6500;
      c.position.set(cp.x + dx, trackY + o.y, cp.z + dz);
    }
    // sun follows the focus point for shadows
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 500);
    // tunnel darkening / exposure adaptation
    const tgt = inTunnel ? 1 : 0;
    this.tunnel += (tgt - this.tunnel) * Math.min(1, dt * (inTunnel ? 1.6 : 0.9));
    this.sun.intensity = P.sunI * (1 - 0.985 * this.tunnel);
    this.hemi.intensity = P.hemiI * (1 - 0.95 * this.tunnel);
    this.scene.environmentIntensity = (P.night ? 0.4 : 1) * (1 - 0.9 * this.tunnel);
    this.scene.fog.near = P.fogNear + 500 * this.tunnel;
    this.scene.fog.far = P.fogFar + 800 * this.tunnel;
    this.renderer.toneMappingExposure = P.exposure * (1 + 0.7 * this.tunnel);
  }

  dispose() {
    for (const o of this.objects) this.scene.remove(o);
    this.envRT.dispose();
    this.scene.environment = null;
  }
}

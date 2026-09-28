// Entry point: renderer, title menu, session lifecycle, cameras and the main loop.

import * as THREE from 'three';
import { LINES, TRAINS, PLAYER_TRAINS, DIFFICULTY, TIMES } from './data.js';
import { Route } from './route.js';
import { Terrain } from './terrain.js';
import { World } from './world.js';
import { Environment } from './sky.js';
import { TrainModel } from './trainmodel.js';
import { Game } from './game.js';
import { HUD } from './hud.js';
import { Sound } from './audio.js';
import { Input } from './input.js';
import { Traffic } from './traffic.js';
import { createAssets } from './assets.js';
import { RNG, clamp, lerp, formatClock, hashString } from './util.js';

const $ = (id) => document.getElementById(id);

// ---------------- renderer ----------------
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.3, 20000);
scene.add(camera);
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

const assets = createAssets(renderer);
const hud = new HUD();
const sound = new Sound();
const input = new Input();

// ---------------- session ----------------
const CAM_MODES = ['cab', 'chase', 'side', 'drone'];

class Session {
  constructor(cfg, demo = false) {
    this.cfg = cfg;
    this.demo = demo;
    const line = LINES.find((l) => l.id === cfg.line);
    const train = TRAINS[cfg.train];
    const diff = DIFFICULTY[cfg.difficulty];
    this.spec = train;
    this.route = new Route({ line, startIdx: cfg.start, stops: cfg.stops, train, seed: cfg.seed, difficulty: diff });
    const rng = new RNG(cfg.seed ^ 0xabc);
    const hour = cfg.time === 'day' ? rng.range(7.5, 15.5) : cfg.time === 'dusk' ? rng.range(17.2, 17.8) : rng.range(19.8, 22.5);
    const startClock = Math.round(hour * 3600 / 5) * 5;
    this.route.buildSchedule(diff.slack, startClock);
    this.terrain = new Terrain(this.route);
    this.env = new Environment(scene, renderer, this.route, cfg.time);
    this.env.setNightMaterials(assets);
    this.world = new World(scene, this.route, this.terrain, assets);
    this.world.aspectFn = (sig) => (this.game ? this.game.aspectOf(sig) : demo ? 3 : sig.base);
    const term = this.route.stations[this.route.stations.length - 1];
    this.train = new TrainModel(train, { env: this.env.envRT.texture, dest: `${train.type === 'local' ? '區間' : '自強'} ${term.zh}` });
    scene.add(this.train.group);
    this.traffic = new Traffic(scene, this.route, this.env.envRT.texture, sound);
    this.head = new THREE.SpotLight(0xfff2d8, 0, 900, 0.16, 0.8, 1.5);
    scene.add(this.head, this.head.target);
    this.camMode = demo ? 'side' : 'cab';
    this.camT = 0;
    this.side = null;
    this.chasePos = null;
    this.time = 0;
    this.demoS = this.route.stations[0].s + 30;
    this.demoV = 20;
    if (!demo) {
      this.game = new Game({
        route: this.route, hud, sound, difficulty: diff, startClock,
        onEnd: (res) => setTimeout(() => showResults(res), res.success ? 600 : 1800),
      });
    }
  }

  get s() {
    return this.game ? this.game.phys.s : this.demoS;
  }
  get v() {
    return this.game ? this.game.phys.v : this.demoV;
  }

  preloadStep(n) {
    const s = this.s;
    this.world.update(s - this.route.trainLen - 450, s + 2600, s, n);
    return this.world.isReady(s - this.route.trainLen - 450, s + 2600);
  }

  update(dt, inp) {
    this.time += dt;
    const r = this.route;
    if (this.demo) {
      const target = Math.min(r.limitAt(this.demoS), 100) / 3.6;
      this.demoV += clamp(target - this.demoV, -0.8 * dt, 0.5 * dt);
      this.demoS += this.demoV * dt;
      if (this.demoS > r.L - 300) this.demoS = r.stations[0].s;
      this.camT += dt;
      if (this.camT > 14) {
        this.camT = 0;
        this.camMode = this.camMode === 'side' ? 'chase' : this.camMode === 'chase' ? 'drone' : 'side';
        this.side = null;
      }
    }
    const s = this.s, v = this.v;
    if (inp.camera && !this.demo) {
      this.camMode = CAM_MODES[(CAM_MODES.indexOf(this.camMode) + 1) % CAM_MODES.length];
      this.side = null;
      this.chasePos = null;
    }
    this.train.place(r, s, 1, 0);
    this.traffic.update(dt, s, v, s > r.stations[0].s + 50 || this.demo, this.cfg.time === 'night');
    const pending = this.world.pendingCount(s - r.trainLen - 450, s + 2600);
    this.world.update(s - r.trainLen - 450, s + 2600, s, pending > 4 ? 3 : 1);
    const trains = [{ s, dir: 1, len: r.trainLen }];
    for (const t of this.traffic.trains) trains.push({ s: t.s, dir: -1, len: t.len });
    this.world.updateDynamic(dt, this.time, trains);
    for (const e of this.world.signals.values()) this.world.setAspect(e.sig.id, this.world.aspectFn(e.sig));

    this.updateCamera(dt, inp);
    const lead = this.train.cars[0];
    const inTunnel = !!(this.camMode === 'cab' || this.camMode === 'chase' ? r.tunnelAt(s - 3) : null);
    this.env.update(dt, camera, lead.position, r.yAt(s), r.headingAt(s), inTunnel, this.terrain.params(s), this.time);

    // headlight
    const night = this.cfg.time === 'night';
    const hp = lead.localToWorld(new THREE.Vector3(9.8 + this.spec.noseLen + 0.3, 1.6, 0));
    this.head.position.copy(hp);
    this.head.target.position.copy(lead.localToWorld(new THREE.Vector3(160, 0.6, 0)));
    this.head.intensity = night ? 2600 : this.cfg.time === 'dusk' ? 900 : 100 + 1600 * this.env.tunnel;

    // crossing bells
    let bell = 0;
    for (const cr of this.world.crossings.values()) {
      if (!cr.active) continue;
      const d = Math.abs(cr.c.s - s);
      bell = Math.max(bell, clamp(1 - d / 600, 0, 1));
    }
    const ph = this.game ? this.game.phys : null;
    sound.update({
      v,
      power: ph ? ph.powerEff : 0.3,
      regen: ph && v > 1 ? clamp(ph.brakeEff / (this.spec.brake / 3.6), 0, 1) * 0.7 : 0,
      brake: ph ? clamp(ph.brakeEff / (this.spec.brake / 3.6), 0, 1.2) : 0,
      tunnel: this.env.tunnel > 0.5,
      bell,
      warn: this.game ? this.game.over || this.game.atpActive : false,
      muted: this.demo || paused,
    });
    if (this.game) {
      hud.update(this.game.hudData());
      hud.setCab(this.camMode === 'cab');
    }
  }

  updateCamera(dt, inp) {
    const r = this.route, s = this.s;
    const lead = this.train.cars[0];
    const look = input.look;
    const k = Math.min(1, dt * 3);
    if (this.camMode === 'cab') {
      camera.fov = 60;
      const eye = lead.localToWorld(new THREE.Vector3(9.8 + this.spec.noseLen * 0.28, 2.74, -0.52));
      const vib = Math.min(1, this.v / 30);
      eye.y += Math.sin(this.time * 23) * 0.004 * vib + Math.sin(this.time * 7.3) * 0.006 * vib;
      camera.position.copy(eye);
      const q = lead.getWorldQuaternion(new THREE.Quaternion());
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2));
      q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(look.y - 0.05, look.x, 0, 'YXZ')));
      camera.quaternion.copy(q);
    } else if (this.camMode === 'chase') {
      camera.fov = 55;
      const inT = r.tunnelAt(s - 30);
      const f = r.frame(s - 34, inT ? 1.2 : -7, {});
      const target = new THREE.Vector3(f.x, f.y + (inT ? 4.6 : 7.5), f.z);
      if (!this.chasePos) this.chasePos = target.clone();
      this.chasePos.lerp(target, k);
      camera.position.copy(this.chasePos);
      const la = r.frame(s + 25, 0, {});
      camera.lookAt(la.x, la.y + 1.5, la.z);
    } else if (this.camMode === 'side') {
      camera.fov = 45;
      const len = r.trainLen;
      if (!this.side || s > this.side.s + len + 40 || s < this.side.s - 700) {
        let ss = s + 160 + Math.random() * 120;
        for (let i = 0; i < 6 && (r.tunnelAt(ss) || r.stationAt(ss, 30)); i++) ss += 120;
        const [bL, bR] = r.bedAt(ss);
        const d = Math.random() < 0.6 ? bL - 2.5 - Math.random() * 4 : bR + 2.5 + Math.random() * 4;
        const f = r.frame(ss, d, {});
        const h = Math.max(this.terrain.height(ss, d), r.hasOcean ? r.seaY + 1 : -1e9);
        this.side = { s: ss, pos: new THREE.Vector3(f.x, Math.max(h, r.yAt(ss) - 1) + 1.7 + Math.random() * 2.5, f.z) };
      }
      camera.position.copy(this.side.pos);
      const tgt = lead.localToWorld(new THREE.Vector3(0, 2, 0));
      camera.lookAt(tgt);
    } else if (this.camMode === 'drone') {
      camera.fov = 50;
      const a = this.time * 0.05;
      const tgt = lead.localToWorld(new THREE.Vector3(-20, 0, 0));
      const pos = lead.localToWorld(new THREE.Vector3(-20 + Math.cos(a) * 70, 45, Math.sin(a) * 70));
      if (!this.chasePos) this.chasePos = pos.clone();
      this.chasePos.lerp(pos, k);
      camera.position.copy(this.chasePos);
      camera.lookAt(tgt);
    }
    camera.updateProjectionMatrix();
  }

  dispose() {
    this.world.disposeAll();
    this.traffic.dispose();
    this.train.dispose();
    this.env.dispose();
    scene.remove(this.head, this.head.target);
    this.head.dispose();
  }
}

// ---------------- menu ----------------
const cfg = {
  line: 'western',
  train: 'EMU800',
  start: 0,
  stops: 5,
  time: 'day',
  difficulty: 'normal',
  seed: Math.floor(Math.random() * 1e9),
};

function stopsFor(line, train, from) {
  const t = TRAINS[train];
  return line.stations.slice(from).filter((s, i) => i === 0 || t.type === 'local' || s.major);
}

function validStarts(line, train) {
  const t = TRAINS[train];
  const out = [];
  line.stations.forEach((s, i) => {
    if (t.type !== 'local' && !s.major) return;
    if (stopsFor(line, train, i).length >= 3) out.push(i);
  });
  return out;
}

function buildMenu() {
  const lc = $('line-cards');
  lc.innerHTML = '';
  for (const l of LINES) {
    const b = document.createElement('button');
    b.className = 'card' + (cfg.line === l.id ? ' sel' : '');
    b.innerHTML = `<div class="c-zh">${l.zh}</div><div class="c-en">${l.en}</div><div class="c-desc">${l.desc}</div>`;
    b.title = l.descEn;
    b.onclick = () => {
      cfg.line = l.id;
      cfg.start = validStarts(l, cfg.train)[0] ?? 0;
      buildMenu();
      restartDemo();
    };
    lc.appendChild(b);
  }
  const tc = $('train-cards');
  tc.innerHTML = '';
  for (const id of PLAYER_TRAINS) {
    const t = TRAINS[id];
    const lv = t.livery;
    const b = document.createElement('button');
    b.className = 'card' + (cfg.train === id ? ' sel' : '');
    b.innerHTML = `<div class="c-zh">${t.zh}</div><div class="c-en">${t.id} · ${t.en}</div>
      <div class="livery" style="background:linear-gradient(180deg, ${lv.body} 0 30%, ${lv.window} 30% 55%, ${lv.stripe} 55% 75%, ${lv.body} 75%)"></div>
      <div class="c-desc">${t.desc}</div>`;
    b.title = t.descEn;
    b.onclick = () => {
      cfg.train = id;
      const vs = validStarts(LINES.find((l) => l.id === cfg.line), id);
      if (!vs.includes(cfg.start)) cfg.start = vs[0] ?? 0;
      buildMenu();
      restartDemo();
    };
    tc.appendChild(b);
  }
  const line = LINES.find((l) => l.id === cfg.line);
  const sel = $('start-select');
  sel.innerHTML = '';
  for (const i of validStarts(line, cfg.train)) {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `${line.stations[i].zh}  ${line.stations[i].en}`;
    if (i === cfg.start) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    cfg.start = +sel.value;
    buildMenu();
  };
  const maxStops = Math.min(8, stopsFor(line, cfg.train, cfg.start).length);
  const range = $('stops');
  range.max = maxStops;
  cfg.stops = Math.min(cfg.stops, maxStops);
  range.value = cfg.stops;
  $('stops-val').textContent = cfg.stops;
  range.oninput = () => {
    cfg.stops = +range.value;
    $('stops-val').textContent = cfg.stops;
    updatePreview();
  };
  updatePreview();
  const seg = (id, obj, key) => {
    const el = $(id);
    el.innerHTML = '';
    for (const [k, v] of Object.entries(obj)) {
      const b = document.createElement('button');
      b.className = cfg[key] === k ? 'sel' : '';
      b.textContent = `${v.zh} ${v.en}`;
      b.onclick = () => {
        cfg[key] = k;
        buildMenu();
        if (key === 'time') restartDemo();
      };
      el.appendChild(b);
    }
  };
  seg('time-seg', TIMES, 'time');
  seg('diff-seg', DIFFICULTY, 'difficulty');
  const seed = $('seed');
  seed.value = cfg.seed;
  seed.onchange = () => {
    const v = seed.value.trim();
    cfg.seed = /^\d+$/.test(v) ? +v % 2147483647 : hashString(v);
  };
}

function updatePreview() {
  const line = LINES.find((l) => l.id === cfg.line);
  const t = TRAINS[cfg.train];
  const parts = [];
  let n = 0;
  for (let i = cfg.start; i < line.stations.length && n < cfg.stops; i++) {
    const s = line.stations[i];
    const stop = i === cfg.start || t.type === 'local' || s.major;
    if (stop) n++;
    parts.push(stop ? `<b>${s.zh}</b>` : `<span class="pass">${s.zh}</span>`);
  }
  $('route-preview').innerHTML = parts.join(' › ');
}

$('dice').onclick = () => {
  const rng = new RNG(Date.now() & 0xffffffff);
  cfg.seed = Math.floor(rng.next() * 1e9);
  cfg.line = rng.pick(LINES).id;
  cfg.train = rng.pick(PLAYER_TRAINS);
  const vs = validStarts(LINES.find((l) => l.id === cfg.line), cfg.train);
  cfg.start = rng.pick(vs);
  buildMenu();
  restartDemo();
};

// ---------------- lifecycle ----------------
let session = null;
let paused = false;
let mode = 'title'; // title | loading | play | result

function show(id, on) {
  $(id).classList.toggle('hidden', !on);
}

function restartDemo() {
  if (mode !== 'title') return;
  if (session) session.dispose();
  session = new Session({ ...cfg, stops: Math.min(cfg.stops, 4) }, true);
  for (let i = 0; i < 400 && !session.preloadStep(4); i++);
}

async function startGame(sameSeed = true) {
  sound.init();
  if (!sameSeed) cfg.seed = Math.floor(Math.random() * 1e9);
  mode = 'loading';
  show('title', false);
  show('result', false);
  show('pause', false);
  show('loading', true);
  hud.show(false);
  hud.clearMessages();
  paused = false;
  if (session) session.dispose();
  session = null;
  $('load-fill').style.width = '5%';
  await new Promise((r) => setTimeout(r, 30));
  session = new Session(cfg, false);
  const total = session.world.pendingCount(session.s - session.route.trainLen - 450, session.s + 2600) || 1;
  let guard = 0;
  while (!session.preloadStep(3) && guard++ < 1000) {
    const left = session.world.pendingCount(session.s - session.route.trainLen - 450, session.s + 2600);
    $('load-fill').style.width = `${Math.round((1 - left / total) * 100)}%`;
    $('load-sub').textContent = `Building world · ${total - left}/${total}`;
    await new Promise((r) => setTimeout(r, 0));
  }
  show('loading', false);
  hud.show(true);
  mode = 'play';
  input.enabled = true;
  const st0 = session.route.stations[0];
  hud.flash(`${st0.zh} 站 · 發車 ${formatClock(st0.dep)}`, 'info', 3.5);
}

function showResults(res) {
  if (mode !== 'play') return;
  mode = 'result';
  input.enabled = false;
  const box = $('res-rank');
  const stops = session.route.stations.filter((s, i) => i > 0 && s.stop).length;
  const ratio = res.score / Math.max(1, stops * 2300 + 2000);
  let rank = ratio >= 0.9 ? 'S' : ratio >= 0.72 ? 'A' : ratio >= 0.52 ? 'B' : ratio >= 0.3 ? 'C' : 'D';
  if (!res.success) rank = 'GAME<br>OVER';
  box.innerHTML = rank;
  box.classList.toggle('fail', !res.success);
  $('res-title').innerHTML = res.success ? '運轉完成 <small>RUN COMPLETE</small>' : '運轉終了 <small>OUT OF TIME</small>';
  const perfect = res.results.filter((r) => r.err !== null && Math.abs(r.err) <= 0.1).length;
  const onTime = res.results.filter((r) => r.late !== null && Math.abs(r.late) <= 1).length;
  $('res-stats').innerHTML = `得分 SCORE <b>${res.score.toLocaleString()}</b><br>剩餘持時 TIME LEFT <b>${res.life.toFixed(1)}s</b><br>完美停車 PERFECT <b>${perfect}</b> · 定時 ON-TIME <b>${onTime}</b>`;
  let html = '<tr><th>車站 Station</th><th>停車誤差 Stop</th><th>到站 Arrival</th><th>得分</th></tr>';
  for (const r of res.results) {
    const e = r.err === null ? '<span class="bad">過站</span>' : `<span class="${Math.abs(r.err) <= 0.5 ? 'good' : Math.abs(r.err) > 5 ? 'bad' : ''}">${r.err >= 0 ? '+' : ''}${r.err.toFixed(2)} m</span>`;
    const l = r.late === null ? '—' : `<span class="${Math.abs(r.late) <= 1 ? 'good' : r.late > 1 ? 'bad' : ''}">${r.late > 0 ? '+' : ''}${r.late}s</span>`;
    html += `<tr><td>${r.st.zh} ${r.st.en}</td><td>${e}</td><td>${l}</td><td>${r.pts}</td></tr>`;
  }
  $('res-table').innerHTML = html;
  show('result', true);
}

function toTitle() {
  mode = 'title';
  input.enabled = false;
  hud.show(false);
  hud.setCab(false);
  sound.silence();
  show('result', false);
  show('pause', false);
  show('title', true);
  paused = false;
  restartDemo();
}

function setPaused(p) {
  if (mode !== 'play') return;
  paused = p;
  show('pause', p);
  if (p) sound.silence();
}

$('start-btn').onclick = () => startGame(true);
$('help-btn').onclick = () => show('help', true);
$('help-close').onclick = () => show('help', false);
document.querySelectorAll('#pause [data-p]').forEach((b) => {
  b.onclick = () => {
    const a = b.dataset.p;
    if (a === 'resume') setPaused(false);
    if (a === 'restart') startGame(true);
    if (a === 'help') show('help', true);
    if (a === 'quit') toTitle();
  };
});
document.querySelectorAll('#result [data-r]').forEach((b) => {
  b.onclick = () => {
    const a = b.dataset.r;
    if (a === 'retry') startGame(true);
    if (a === 'new') startGame(false);
    if (a === 'title') toTitle();
  };
});
$('volume').oninput = (e) => sound.setVolume((+e.target.value / 100) * 1.0);

// ---------------- main loop ----------------
const timer = new THREE.Timer();
function frame() {
  requestAnimationFrame(frame);
  timer.update();
  tick(Math.min(0.05, timer.getDelta()));
}

function tick(dt, extra = null) {
  input.update(dt);
  const inp = input.consume();
  inp.horn = input.horn;
  inp.ff = input.ff;
  if (extra) Object.assign(inp, extra);
  if (inp.help) show('help', $('help').classList.contains('hidden'));
  if (inp.pause) {
    if (!$('help').classList.contains('hidden')) show('help', false);
    else setPaused(!paused);
  }
  if (session && mode !== 'loading') {
    if (session.game && mode === 'play' && !paused) session.game.update(dt, inp);
    if (!paused) session.update(dt, inp);
  }
  renderer.render(scene, camera);
}

buildMenu();
restartDemo();
frame();

// debug handle (used for automated testing when the page is not visible)
window.__tra = {
  get session() { return session; },
  get mode() { return mode; },
  THREE, renderer, scene, camera, cfg,
  start(over = {}) {
    Object.assign(cfg, over);
    return startGame(true);
  },
  tp(x, v = 0) {
    const g = session.game, r = session.route;
    g.phys.s = x;
    g.phys.v = v / 3.6;
    g.phys.notch = 0;
    g.state = 'run';
    g.departed.add(0);
    g.sigIdx = r.nextSignalIndex(x);
    g.nextStop = -1;
    for (let i = 1; i < r.stations.length; i++) if (r.stations[i].stop && r.stations[i].s > x - 50) { g.nextStop = i; break; }
    while (g.wIdx < r.whistles.length && r.whistles[g.wIdx].end < x) g.wIdx++;
    for (let i = 0; i < 60; i++) tick(1 / 30);
  },
  hud(on) {
    $('hud').style.visibility = on ? '' : 'hidden';
    $('cabframe').style.visibility = on ? '' : 'hidden';
  },
  step(n = 1, dt = 1 / 30, extra = null) {
    for (let i = 0; i < n; i++) tick(dt, i === 0 ? extra : extra && { horn: extra.horn, ff: extra.ff });
  },
};

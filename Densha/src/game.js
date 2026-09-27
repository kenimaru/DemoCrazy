// Densha-de-Go style rules: timetable, stop-position judging, speed limits, signals/ATP,
// whistle boards and the "remaining time" life system.

import { ASPECT_LIMIT } from './data.js';
import { TrainPhysics } from './physics.js';
import { clamp, formatClock } from './util.js';

const AXLES = [2.05, 4.15, 15.95, 18.05, 22.05, 24.15, 35.95, 38.05];

export class Game {
  constructor({ route, hud, sound, difficulty, startClock, onEnd }) {
    this.r = route;
    this.hud = hud;
    this.snd = sound;
    this.diff = difficulty;
    this.onEnd = onEnd;
    this.spec = route.train;
    this.phys = new TrainPhysics(route.train, route.stations[0].s);
    this.clock = startClock;
    this.life = difficulty.life;
    this.score = 0;
    this.state = 'dwell';
    this.stationIdx = 0;
    this.depTime = route.stations[0].dep;
    this.departed = new Set();
    this.doors = true;
    this.doorsClosing = false;
    this.nextStop = this.findNextStop(1);
    this.sigIdx = route.nextSignalIndex(this.phys.s);
    this.sigLimit = 999;
    this.atpActive = false;
    this.spadHold = false;
    this.ebPen = false;
    this.wIdx = 0;
    while (this.wIdx < route.whistles.length && route.whistles[this.wIdx].s < this.phys.s) this.wIdx++;
    this.results = [];
    this.retries = 0;
    this.lastV = 0;
    this.over = false;
    this.ended = false;
    this.finishTimer = -1;
    this.accelSm = 0;
    this.lastNotch = this.phys.notch;
    for (const ev of route.events) ev.t0 = -1;
    for (const w of route.whistles) w.done = false;
    for (const st of route.stations) st.passed = false;
    this.overWarned = false;
  }

  findNextStop(from) {
    const st = this.r.stations;
    for (let i = from; i < st.length; i++) if (st[i].stop) return i;
    return -1;
  }

  aspectOf(sig) {
    if (sig.type === 'start') {
      const st = this.r.stations[sig.station];
      if (st.stop && !this.departed.has(sig.station)) return 0;
    }
    const base = sig.base;
    if (sig.group >= 0) {
      const ev = this.r.events[sig.group];
      if (ev.t0 < 0) return base;
      const e = this.clock - ev.t0 - ev.delay;
      if (e < 0) return base;
      return Math.min(3, base + 1 + Math.floor(e / 7));
    }
    return base;
  }

  currentLimit() {
    return Math.min(this.r.limitAt(this.phys.s), this.sigLimit);
  }

  penalty(sec, text, cls = 'bad') {
    this.life -= sec;
    if (text) this.hud.flash(text, cls);
  }

  update(dt, inp) {
    if (this.ended) return;
    const r = this.r, ph = this.phys, snd = this.snd, hud = this.hud;
    if (this.finishTimer > 0) {
      this.finishTimer -= dt;
      this.clock += dt;
      if (this.finishTimer <= 0) this.end(true);
      return;
    }
    const scale = this.state === 'dwell' && inp.ff ? 8 : 1;
    const gdt = dt * scale;
    this.clock += gdt;

    // ---- master controller ----
    const prev = ph.notch;
    if (inp.eb) ph.notch = -9;
    if (inp.neutral) ph.notch = 0;
    if (inp.delta) ph.notch = clamp(ph.notch + inp.delta, -9, 5);
    if (ph.notch !== prev) {
      snd.notch();
      if (ph.notch > prev && prev < 0) snd.air(0.06 + 0.02 * (ph.notch - prev));
    }
    snd.horn(inp.horn);

    // ---- station dwell ----
    if (this.state === 'dwell') {
      const dep = this.depTime;
      if (!this.doorsClosing && this.clock >= dep - 10) {
        this.doorsClosing = true;
        snd.doorChime();
        hud.flash('車門關閉 <small>DOORS CLOSING</small>', 'info', 2);
      }
      if (this.doors && this.clock >= dep - 4) {
        this.doors = false;
        snd.air(0.12);
      }
      if (this.clock >= dep) {
        this.state = 'run';
        this.departed.add(this.stationIdx);
        this.nextStop = this.findNextStop(this.stationIdx + 1);
        this.retries = 0;
        snd.departBell();
        hud.flash('出發進行 <small>DEPART</small>', 'good', 2);
      }
    }
    ph.powerCut = this.state !== 'run';

    // ---- events trigger ----
    for (const ev of r.events) if (ev.t0 < 0 && ph.s > ev.trigger - 1000) ev.t0 = this.clock;

    // ---- physics ----
    const sPrev = ph.s;
    const grade = r.gradeAt(ph.s - r.trainLen * 0.5);
    const n = Math.max(1, Math.ceil(gdt * 120));
    for (let i = 0; i < n; i++) ph.step(gdt / n, grade);
    const s = ph.s, v = ph.v, kmh = v * 3.6;
    this.accelSm += (ph.a * 3.6 - this.accelSm) * Math.min(1, dt * 4);

    // rail joints
    if (v > 0.3) {
      const vol = clamp(kmh / 90, 0.12, 1) * (r.tunnelAt(s) ? 0.8 : 0.5);
      for (const o0 of AXLES) {
        const o = o0 + this.spec.noseLen;
        if (Math.floor((sPrev - o) / 25) < Math.floor((s - o) / 25)) snd.joint(vol / (1 + o / 14));
      }
    }

    // ---- signals ----
    const sig = r.signals;
    while (this.sigIdx >= 0 && this.sigIdx < sig.length && sig[this.sigIdx].s <= s) {
      const g = sig[this.sigIdx];
      const asp = this.aspectOf(g);
      this.sigLimit = ASPECT_LIMIT[asp];
      if (asp === 0) {
        this.spadHold = true;
        this.penalty(20, '冒進號誌！ATP 緊急停車 <small>SIGNAL PASSED AT DANGER −20s</small>');
        snd.bad();
      }
      this.sigIdx++;
    }

    // ---- speed limits / ATP ----
    const lim = this.currentLimit();
    this.over = kmh > lim + 1;
    if (this.over) {
      this.life -= gdt * (0.8 + (kmh - lim) * 0.04);
      this.score = Math.max(0, this.score - gdt * 25);
      if (!this.overWarned) {
        this.overWarned = true;
        hud.flash(`速度超過！ 限速 ${lim} <small>OVERSPEED</small>`, 'bad', 1.6);
      }
    } else if (kmh < lim - 1) this.overWarned = false;
    if (!this.atpActive && kmh > lim + 8) {
      this.atpActive = true;
      this.penalty(5, 'ATP 制動介入 <small>ATP BRAKE −5s</small>');
      snd.bad();
    }
    if (this.atpActive && (kmh < lim - 3 || v === 0)) this.atpActive = false;
    if (this.spadHold && v === 0) this.spadHold = false;
    ph.overrideBrake = this.spadHold ? this.spec.eb / 3.6 : this.atpActive ? this.spec.brake / 3.6 : 0;

    if (ph.notch === -9 && kmh > 5 && !this.ebPen && !this.spadHold) {
      this.ebPen = true;
      this.penalty(2, '非常制動 <small>EMERGENCY BRAKE −2s</small>', 'warn');
    }
    if (ph.notch !== -9) this.ebPen = false;

    // ---- whistle boards ----
    const W = r.whistles;
    for (let i = this.wIdx; i < W.length && W[i].s <= s; i++) {
      const w = W[i];
      if (!w.done && inp.horn && s <= w.end) {
        w.done = true;
        this.life += 1;
        this.score += 100;
        hud.flash('鳴笛 ✓ <small>+1s</small>', 'good', 1.5);
      }
    }
    while (this.wIdx < W.length && W[this.wIdx].end < s) {
      const w = W[this.wIdx];
      if (!w.done) this.penalty(2, `未鳴笛 <small>NO HORN (${w.kind === 'crossing' ? '平交道' : '隧道'}) −2s</small>`, 'warn');
      this.wIdx++;
    }

    // ---- passing stations ----
    for (const st of r.stations) {
      if (st.stop || st.passed || s < st.s) continue;
      st.passed = true;
      if (st.pass) {
        const d = Math.round(this.clock - st.pass);
        if (Math.abs(d) <= 2) {
          this.life += 2;
          this.score += 300;
          hud.flash(`定時通過 ${st.zh} <small>ON-TIME PASS +2s</small>`, 'good');
        } else hud.flash(`通過 ${st.zh} <small>${d > 0 ? '+' : ''}${d}s</small>`, 'info', 1.6);
      }
    }

    // ---- stopping ----
    const ns = this.nextStop;
    if (this.state === 'run' && ns >= 0) {
      const st = r.stations[ns];
      const err = s - st.s;
      if (v === 0 && this.lastV > 0) {
        if (err >= -5 && err < 220) this.arrive(st, ns, err);
        else if (err < -5 && s > st.pStart - 60) {
          this.retries++;
          hud.flash(`停車位置未到 <small>還有 ${(-err).toFixed(1)} m · MOVE UP</small>`, 'warn', 2);
          if (this.retries > 1) this.penalty(1, null);
        }
      } else if (err >= 220 && v > 0) {
        this.penalty(30, `過站不停！ ${st.zh} <small>MISSED STOP −30s</small>`);
        this.results.push({ st, err: null, late: null, pts: 0, missed: true });
        st.passed = true;
        this.departed.add(ns);
        this.nextStop = this.findNextStop(ns + 1);
      }
    }
    this.lastV = v;

    if (this.life <= 0) {
      this.life = 0;
      this.end(false);
    }
  }

  arrive(st, idx, err) {
    const snd = this.snd, hud = this.hud;
    this.state = 'dwell';
    this.stationIdx = idx;
    this.doors = true;
    this.doorsClosing = false;
    const a = Math.abs(err);
    let label, dl = 0, pts = 0, cls = 'good';
    if (a <= 0.1) { label = '完美停車 PERFECT'; dl = 5; pts = 1500; cls = 'perfect'; }
    else if (a <= 0.5) { label = '極佳 GREAT'; dl = 3; pts = 1000; }
    else if (a <= 1) { label = '良好 GOOD'; dl = 2; pts = 700; }
    else if (a <= 2) { label = '尚可 OK'; dl = 1; pts = 400; cls = 'info'; }
    else if (a <= 5) { label = '偏差 OFF'; dl = 0; pts = 150; cls = 'warn'; }
    else { label = err > 0 ? '越過停車位置 OVERRUN' : '停車不良 BAD STOP'; dl = -Math.min(25, (a - 5) * 1.2); cls = 'bad'; }
    this.life += dl;
    const late = Math.round(this.clock - st.arr);
    let tmsg, tcls = 'info';
    if (Math.abs(late) <= 1) {
      this.life += 3;
      pts += 800;
      tmsg = '定時到站 ON TIME <small>+3s</small>';
      tcls = 'good';
    } else if (late > 1) {
      this.life -= late;
      pts += Math.max(0, 400 - late * 15);
      tmsg = `誤點 ${late} 秒 <small>LATE −${late}s</small>`;
      tcls = 'bad';
    } else {
      pts += 300;
      tmsg = `早到 ${-late} 秒 <small>EARLY</small>`;
    }
    this.score += pts;
    this.results.push({ st, err, late, pts });
    hud.flash(`${label}<small>${err >= 0 ? '+' : ''}${err.toFixed(2)} m ${dl ? `· ${dl > 0 ? '+' : ''}${dl.toFixed(0)}s` : ''}</small>`, cls, 3.2);
    setTimeout(() => !this.ended && hud.flash(tmsg, tcls, 3), 700);
    if (cls === 'perfect' || dl >= 3) snd.good();
    else if (cls === 'bad') snd.bad();
    snd.doorOpen();
    setTimeout(() => !this.ended && snd.arrivalJingle(), 900);
    const last = idx === this.r.stations.length - 1;
    if (last) {
      this.finishTimer = 4;
    } else {
      this.depTime = Math.max(st.dep, this.clock + 18);
      this.nextStop = -1;
    }
    this.phys.notch = Math.min(this.phys.notch, -4);
  }

  end(success) {
    if (this.ended) return;
    this.ended = true;
    this.snd.silence();
    if (success) this.score += Math.round(this.life * 50);
    this.onEnd && this.onEnd({ success, results: this.results, score: Math.round(this.score), life: this.life });
  }

  hudData() {
    const r = this.r, ph = this.phys, s = ph.s, kmh = ph.v * 3.6;
    const lim = this.currentLimit();
    const st = r.stations;
    const tgtIdx = this.state === 'dwell' ? this.stationIdx : this.nextStop;
    const tgt = tgtIdx >= 0 ? st[tgtIdx] : null;
    const nextStopIdx = this.state === 'dwell' ? this.findNextStop(this.stationIdx + 1) : this.nextStop;
    const ns = nextStopIdx >= 0 ? st[nextStopIdx] : null;
    let nextPhys = null;
    for (const x of st) if (x.s > s + 1) { nextPhys = x; break; }
    const term = st[st.length - 1];
    const drop = r.nextLimitDrop(s, 1800);
    const si = this.sigIdx;
    const sig = si >= 0 && si < r.signals.length ? r.signals[si] : null;
    const sigD = sig ? sig.s - s : null;
    const g = r.gradeAt(s) * 1000;
    let ttDelta = '';
    let ttArr = '—', ttSta = '—', ttDist = '—';
    if (this.state === 'dwell' && this.stationIdx < st.length - 1) {
      const left = Math.max(0, this.depTime - this.clock);
      ttSta = `${st[this.stationIdx].zh}`;
      ttArr = `發 ${formatClock(this.depTime)}`;
      ttDelta = `<span class="dep">發車倒數 ${Math.ceil(left)}s</span>${left > 12 ? ' <small>[Enter 快轉]</small>' : ''}`;
      ttDist = ns ? `${((ns.s - s) / 1000).toFixed(2)} km` : '—';
    } else if (tgt) {
      ttSta = tgt.zh;
      ttArr = formatClock(tgt.arr);
      const dist = tgt.s - s;
      ttDist = dist > 1000 ? `${(dist / 1000).toFixed(2)} km` : `${dist.toFixed(0)} m`;
      const rem = tgt.arr - this.clock;
      ttDelta = rem >= 0 ? `<span class="ok">剩餘 ${Math.floor(rem / 60)}:${String(Math.floor(rem % 60)).padStart(2, '0')}</span>` : `<span class="late">誤點 +${Math.ceil(-rem)}s</span>`;
    }
    const approach = this.state === 'run' && tgt ? tgt.s - s : null;
    return {
      speed: kmh,
      limit: lim,
      dialMax: this.spec.vmax > 110 ? 160 : 140,
      accel: this.accelSm,
      brakeFrac: ph.brakeEff / (this.spec.eb / 3.6),
      powerFrac: ph.powerEff,
      notch: ph.notch,
      life: this.life,
      score: this.score,
      nextName: ns ? `${ns.zh} <small>${ns.en}</small>` : `${term.zh} <small>終點 Terminal</small>`,
      ledSub: `${this.spec.zh} ${this.spec.id} · 往 ${term.zh} ${nextPhys && !nextPhys.stop ? `· 通過 ${nextPhys.zh}` : ''}`,
      nextLimit: drop ? `前方限速 <b>${drop.v}</b> · ${Math.round(drop.s - s)} m` : '前方無限速',
      sigDist: sig && sigD < 2500 ? `${sig.type === 'home' ? '進站' : sig.type === 'start' ? '出發' : '閉塞'}號誌 ${Math.round(sigD)} m` : '—',
      sigAspect: sig && sigD < 1300 ? this.aspectOf(sig) : -1,
      grade: `坡度 ${g > 0.3 ? '↗' : g < -0.3 ? '↘' : '→'} ${g > 0 ? '+' : ''}${g.toFixed(1)}‰`,
      ttStation: ttSta,
      ttArr,
      clock: this.clock,
      ttDist,
      ttDelta,
      doors: this.doors,
      atp: this.atpActive || this.spadHold,
      eb: ph.notch === -9,
      over: this.over,
      approach,
      reqDecel: approach !== null && approach > 0.3 && ph.v > 0.2 ? ((ph.v * ph.v) / (2 * approach)) * 3.6 : null,
    };
  }
}

// Synthesised train sounds via WebAudio: traction motor / inverter, rolling noise,
// rail joints, horn, brakes, crossing bells, chimes and warnings.

import { clamp } from './util.js';

export class Sound {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.hornOn = false;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = 0.55;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp);
    comp.connect(ctx.destination);

    // noise buffer
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b = 0.97 * b + 0.03 * w; // brownish
      d[i] = w * 0.35 + b * 3.5;
    }
    this.noiseBuf = buf;

    // rolling noise
    this.roll = ctx.createBufferSource();
    this.roll.buffer = buf;
    this.roll.loop = true;
    this.rollF = ctx.createBiquadFilter();
    this.rollF.type = 'lowpass';
    this.rollF.frequency.value = 300;
    this.rollG = ctx.createGain();
    this.rollG.gain.value = 0;
    this.roll.connect(this.rollF).connect(this.rollG).connect(this.master);
    this.roll.start();

    // traction motor hum + inverter whine
    this.mot = ctx.createOscillator();
    this.mot.type = 'sawtooth';
    this.mot2 = ctx.createOscillator();
    this.mot2.type = 'square';
    this.motF = ctx.createBiquadFilter();
    this.motF.type = 'lowpass';
    this.motF.frequency.value = 900;
    this.motG = ctx.createGain();
    this.motG.gain.value = 0;
    this.mot.connect(this.motF);
    this.mot2.connect(this.motF);
    this.motF.connect(this.motG).connect(this.master);
    this.inv = ctx.createOscillator();
    this.inv.type = 'sawtooth';
    this.invF = ctx.createBiquadFilter();
    this.invF.type = 'bandpass';
    this.invF.Q.value = 6;
    this.invG = ctx.createGain();
    this.invG.gain.value = 0;
    this.inv.connect(this.invF).connect(this.invG).connect(this.master);
    this.mot.start();
    this.mot2.start();
    this.inv.start();

    // horn: two detuned chords through a formant filter
    this.hornG = ctx.createGain();
    this.hornG.gain.value = 0;
    const hf = ctx.createBiquadFilter();
    hf.type = 'bandpass';
    hf.frequency.value = 900;
    hf.Q.value = 0.8;
    hf.connect(this.hornG).connect(this.master);
    for (const f of [311, 370, 466, 622]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.12;
      o.connect(g).connect(hf);
      o.start();
    }

    // brake hiss channel
    this.hiss = ctx.createBufferSource();
    this.hiss.buffer = buf;
    this.hiss.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    this.hissG = ctx.createGain();
    this.hissG.gain.value = 0;
    this.hiss.connect(hp).connect(this.hissG).connect(this.master);
    this.hiss.start();

    // brake squeal at low speed
    this.sq = ctx.createOscillator();
    this.sq.type = 'triangle';
    this.sq.frequency.value = 2400;
    this.sqG = ctx.createGain();
    this.sqG.gain.value = 0;
    this.sq.connect(this.sqG).connect(this.master);
    this.sq.start();

    this.bellNext = 0;
    this.bellHi = false;
    this.warnNext = 0;
  }

  get t() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  setVolume(v) {
    if (this.master) this.master.gain.value = v;
  }

  // Continuous state update each frame
  update(st) {
    if (!this.ctx) return;
    const t = this.t;
    const kmh = st.v * 3.6;
    const tc = 0.08;
    // rolling
    const rv = clamp(kmh / 110, 0, 1.2);
    this.rollG.gain.setTargetAtTime(st.muted ? 0 : rv * (st.tunnel ? 0.9 : 0.45) + (kmh > 0.5 ? 0.02 : 0), t, 0.2);
    this.rollF.frequency.setTargetAtTime(160 + kmh * 9 + (st.tunnel ? 300 : 0), t, 0.2);
    // motor effort
    const effort = Math.max(st.power, st.regen);
    const motVol = st.muted ? 0 : clamp(effort, 0, 1) * clamp(kmh / 6, 0.15, 1) * 0.16;
    this.motG.gain.setTargetAtTime(motVol, t, tc);
    const fm = 18 + kmh * 2.35;
    this.mot.frequency.setTargetAtTime(fm, t, tc);
    this.mot2.frequency.setTargetAtTime(fm * 2.01, t, tc);
    this.motF.frequency.setTargetAtTime(500 + kmh * 12, t, tc);
    // inverter: stepped synchronous modes at low speed, rising async whine
    let fi;
    if (kmh < 12) fi = 520 + kmh * 18;
    else if (kmh < 30) fi = 380 + (kmh - 12) * 42;
    else if (kmh < 55) fi = 700 + (kmh - 30) * 24;
    else fi = 1100 + (kmh - 55) * 8;
    this.inv.frequency.setTargetAtTime(fi, t, tc);
    this.invF.frequency.setTargetAtTime(fi, t, tc);
    this.invG.gain.setTargetAtTime(st.muted ? 0 : clamp(effort, 0, 1) * (kmh < 90 ? 0.06 : 0.03), t, tc);
    // brakes
    this.sqG.gain.setTargetAtTime(!st.muted && st.brake > 0.3 && kmh < 14 && kmh > 0.3 ? 0.012 * st.brake : 0, t, 0.1);
    this.sq.frequency.setTargetAtTime(2200 + kmh * 40, t, 0.1);
    // horn
    this.hornG.gain.setTargetAtTime(this.hornOn && !st.muted ? 0.5 : 0, t, this.hornOn ? 0.03 : 0.07);
    // crossing bells
    if (st.bell > 0.01 && t > this.bellNext) {
      this.bellNext = t + 0.42;
      this.bellHi = !this.bellHi;
      this.ding(this.bellHi ? 760 : 700, st.bell * 0.25);
    }
    // ATP / overspeed warning
    if (st.warn && t > this.warnNext) {
      this.warnNext = t + 0.5;
      this.beep(1400, 0.08, 0.12);
    }
  }

  horn(on) {
    this.hornOn = on;
  }

  ding(f, vol) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (const [m, v] of [[1, 1], [2.76, 0.3], [5.4, 0.12]]) {
      const o = ctx.createOscillator();
      o.frequency.value = f * m;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol * v, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 0.65);
    }
  }

  beep(f, dur, vol = 0.1, when = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.005);
    g.gain.setValueAtTime(vol, t + dur - 0.01);
    g.gain.linearRampToValueAtTime(0, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3000;
    o.connect(lp).connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  tone(f, dur, vol, when = 0, type = 'sine') {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // rail joint click
  joint(vol, delay = 0) {
    if (!this.ctx || vol < 0.01) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 700;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol * 0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5, 0.12);
  }

  notch() {
    this.beep(2600, 0.012, 0.05);
  }

  air(vol = 0.25) {
    if (!this.ctx) return;
    const t = this.t;
    this.hissG.gain.cancelScheduledValues(t);
    this.hissG.gain.setValueAtTime(vol, t);
    this.hissG.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
  }

  doorChime() {
    // TRA-style door closing beeps
    for (let i = 0; i < 6; i++) this.beep(1050, 0.18, 0.06, i * 0.36);
  }

  doorOpen() {
    this.air(0.18);
    this.tone(880, 0.5, 0.08, 0.05);
    this.tone(660, 0.6, 0.08, 0.3);
  }

  arrivalJingle() {
    const n = [659, 784, 988, 880, 784, 988];
    n.forEach((f, i) => this.tone(f, 0.45, 0.07, i * 0.22, 'triangle'));
  }

  departBell() {
    // platform departure buzzer
    for (let i = 0; i < 3; i++) this.tone(1200, 0.28, 0.05, i * 0.32, 'square');
  }

  good() {
    [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, 0.35, 0.08, i * 0.09, 'triangle'));
  }

  bad() {
    [330, 262].forEach((f, i) => this.tone(f, 0.4, 0.1, i * 0.2, 'sawtooth'));
  }

  passBy(vol) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.t;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(400, t);
    f.frequency.linearRampToValueAtTime(1400, t + 0.6);
    f.frequency.linearRampToValueAtTime(300, t + 3.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.8);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, 0, 3.9);
  }

  silence() {
    if (!this.ctx) return;
    const t = this.t;
    for (const g of [this.rollG, this.motG, this.invG, this.hornG, this.sqG]) g.gain.setTargetAtTime(0, t, 0.05);
    this.hornOn = false;
  }
}

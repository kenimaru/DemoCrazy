// DOM heads-up display: cab instruments, timetable, messages.

import { formatClock, clamp } from './util.js';

const $ = (id) => document.getElementById(id);
const NOTCH_LABELS = ['EB', 'B8', 'B7', 'B6', 'B5', 'B4', 'B3', 'B2', 'B1', 'N', 'P1', 'P2', 'P3', 'P4', 'P5'];
const ASPECT_CLASS = ['r', 'y', 'yg', 'g'];

export class HUD {
  constructor() {
    this.el = $('hud');
    this.speedo = $('speedo').getContext('2d');
    this.bc = $('bc').getContext('2d');
    const nb = $('notches');
    nb.innerHTML = '';
    this.notchEls = [];
    for (let i = NOTCH_LABELS.length - 1; i >= 0; i--) {
      const d = document.createElement('div');
      d.className = 'notch ' + (i === 0 ? 'eb' : i < 9 ? 'b' : i === 9 ? 'n' : 'p');
      d.textContent = NOTCH_LABELS[i];
      nb.appendChild(d);
      this.notchEls[i] = d;
    }
    this.last = {};
    this.msgBox = $('messages');
  }

  show(on) {
    this.el.classList.toggle('hidden', !on);
  }

  setCab(on) {
    $('cabframe').classList.toggle('hidden', !on);
  }

  text(id, v) {
    if (this.last[id] !== v) {
      this.last[id] = v;
      $(id).innerHTML = v;
    }
  }

  flash(text, cls = '', dur = 2.4) {
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.innerHTML = text;
    this.msgBox.appendChild(d);
    while (this.msgBox.children.length > 4) this.msgBox.firstChild.remove();
    setTimeout(() => d.classList.add('out'), dur * 1000);
    setTimeout(() => d.remove(), dur * 1000 + 600);
  }

  clearMessages() {
    this.msgBox.innerHTML = '';
  }

  update(h) {
    this.drawSpeedo(h.speed, h.limit, h.dialMax, h.accel);
    this.drawBC(h.brakeFrac, h.powerFrac);
    const ni = h.notch + 9;
    if (this.last.notch !== ni) {
      this.notchEls.forEach((e, i) => e.classList.toggle('on', i === ni));
      this.last.notch = ni;
    }
    this.text('life', h.life.toFixed(1));
    $('life').classList.toggle('low', h.life < 10);
    this.text('score', Math.round(h.score).toLocaleString());
    this.text('led-next', h.nextName);
    this.text('led-sub', h.ledSub);
    this.text('atp-lim', h.limit >= 999 ? '—' : String(h.limit));
    this.text('atp-next', h.nextLimit);
    this.text('sig-dist', h.sigDist);
    this.text('grade', h.grade);
    const sl = $('sig-lamps');
    const cls = 'sig-lamps ' + (h.sigAspect >= 0 ? ASPECT_CLASS[h.sigAspect] : '');
    if (sl.className !== cls) sl.className = cls;
    this.text('tt-sta', h.ttStation);
    this.text('tt-arr', h.ttArr);
    this.text('tt-now', formatClock(h.clock));
    this.text('tt-dist', h.ttDist);
    this.text('tt-delta', h.ttDelta);
    $('lamp-door').classList.toggle('on', h.doors);
    $('lamp-atp').classList.toggle('on', h.atp);
    $('lamp-eb').classList.toggle('on', h.eb);
    $('atp-panel').classList.toggle('over', h.over);
    // approach meter
    const ap = $('approach');
    const show = h.approach !== null && h.approach < 400 && h.approach > -30;
    ap.classList.toggle('hidden', !show);
    if (show) {
      const d = h.approach;
      this.text('approach-dist', `${d.toFixed(d < 10 ? 2 : 1)}<span>m</span>`);
      const pct = clamp(1 - d / 400, 0, 1.06) * 100;
      $('ap-fill').style.width = `${Math.min(100, pct)}%`;
      ap.classList.toggle('close', d < 10);
      ap.classList.toggle('over', d < -0.5);
      this.text('approach-req', h.reqDecel !== null ? `所需減速 ${h.reqDecel.toFixed(1)} km/h/s` : '');
    }
  }

  drawSpeedo(v, limit, max, accel) {
    const g = this.speedo;
    const W = g.canvas.width, H = g.canvas.height;
    const cx = W / 2, cy = H / 2, R = W * 0.44;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#0d1116';
    g.beginPath();
    g.arc(cx, cy, R + 8, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#3a4450';
    g.lineWidth = 3;
    g.stroke();
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    const ang = (x) => a0 + (a1 - a0) * clamp(x / max, 0, 1.02);
    // limit arc
    if (limit < 999) {
      g.strokeStyle = 'rgba(255,60,50,0.85)';
      g.lineWidth = 7;
      g.beginPath();
      g.arc(cx, cy, R - 4, ang(limit), a1);
      g.stroke();
    }
    g.fillStyle = '#e8edf2';
    g.strokeStyle = '#e8edf2';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '600 15px "Share Tech Mono", monospace';
    for (let x = 0; x <= max; x += 5) {
      const a = ang(x);
      const major = x % 20 === 0;
      const r0 = R - (major ? 16 : x % 10 === 0 ? 11 : 7);
      g.lineWidth = major ? 2.5 : 1.2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      g.stroke();
      if (major) g.fillText(String(x), cx + Math.cos(a) * (R - 30), cy + Math.sin(a) * (R - 30));
    }
    // limit marker
    if (limit < 999) {
      const a = ang(limit);
      g.fillStyle = '#ff3b30';
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (R + 7), cy + Math.sin(a) * (R + 7));
      g.lineTo(cx + Math.cos(a + 0.06) * (R - 12), cy + Math.sin(a + 0.06) * (R - 12));
      g.lineTo(cx + Math.cos(a - 0.06) * (R - 12), cy + Math.sin(a - 0.06) * (R - 12));
      g.fill();
    }
    // needle
    const a = ang(v);
    g.strokeStyle = '#ff9d1c';
    g.lineWidth = 4;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx - Math.cos(a) * 14, cy - Math.sin(a) * 14);
    g.lineTo(cx + Math.cos(a) * (R - 10), cy + Math.sin(a) * (R - 10));
    g.stroke();
    g.fillStyle = '#2b333d';
    g.beginPath();
    g.arc(cx, cy, 11, 0, Math.PI * 2);
    g.fill();
    // digital
    g.fillStyle = v > limit + 1 ? '#ff4d3d' : '#7dffb0';
    g.font = '700 34px "Share Tech Mono", monospace';
    g.fillText(Math.floor(v + 0.001).toString().padStart(3, ' '), cx, cy + R * 0.48);
    g.fillStyle = '#8b98a6';
    g.font = '600 12px "Share Tech Mono", monospace';
    g.fillText('km/h', cx, cy + R * 0.68);
    g.fillText(`${accel >= 0 ? '+' : ''}${accel.toFixed(1)} km/h/s`, cx, cy - R * 0.36);
  }

  drawBC(b, p) {
    const g = this.bc;
    const W = g.canvas.width, H = g.canvas.height;
    const cx = W / 2, cy = H / 2 + 6, R = W * 0.4;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#0d1116';
    g.beginPath();
    g.arc(cx, cy, R + 6, 0, Math.PI * 2);
    g.fill();
    const a0 = Math.PI * 0.8, a1 = Math.PI * 2.2;
    g.strokeStyle = '#56626e';
    g.lineWidth = 1.5;
    for (let i = 0; i <= 10; i++) {
      const a = a0 + ((a1 - a0) * i) / 10;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (R - 6), cy + Math.sin(a) * (R - 6));
      g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      g.stroke();
    }
    const needle = (f, col) => {
      const a = a0 + (a1 - a0) * clamp(f, 0, 1);
      g.strokeStyle = col;
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a) * (R - 4), cy + Math.sin(a) * (R - 4));
      g.stroke();
    };
    needle(0.82, '#ffffff55');
    needle(b, '#ff5a4a');
    g.fillStyle = '#8b98a6';
    g.font = '600 10px "Share Tech Mono", monospace';
    g.textAlign = 'center';
    g.fillText('BC', cx, cy + R * 0.55);
    // power bar
    g.fillStyle = '#1f2833';
    g.fillRect(8, 6, W - 16, 7);
    g.fillStyle = '#3fd07a';
    g.fillRect(8, 6, (W - 16) * clamp(p, 0, 1), 7);
  }
}

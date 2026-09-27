// Keyboard / mouse wheel / touch / gamepad input for the master controller.

const POWER_KEYS = new Set(['ArrowUp', 'KeyW', 'KeyQ']);
const BRAKE_KEYS = new Set(['ArrowDown', 'KeyS', 'KeyZ']);

export class Input {
  constructor() {
    this.delta = 0;
    this.eb = false;
    this.neutral = false;
    this.horn = false;
    this.camera = false;
    this.pause = false;
    this.help = false;
    this.ff = false;
    this.hold = 0; // +1 power, -1 brake
    this.holdT = 0;
    this.touchHorn = false;
    this.keyHorn = false;
    this.look = { x: 0, y: 0, dragging: false, lx: 0, ly: 0 };
    this.enabled = false;

    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => {
      this.hold = 0;
      this.keyHorn = false;
      this.ff = false;
    });
    window.addEventListener('wheel', (e) => {
      if (!this.enabled || e.target.closest('.screen')) return;
      this.delta += e.deltaY < 0 ? 1 : -1;
    }, { passive: true });

    const cvs = () => document.querySelector('canvas#gl');
    window.addEventListener('pointerdown', (e) => {
      if (e.target !== cvs()) return;
      this.look.dragging = true;
      this.look.lx = e.clientX;
      this.look.ly = e.clientY;
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.look.dragging) return;
      this.look.x -= (e.clientX - this.look.lx) * 0.004;
      this.look.y -= (e.clientY - this.look.ly) * 0.004;
      this.look.y = Math.max(-0.8, Math.min(0.6, this.look.y));
      this.look.x = Math.max(-2.2, Math.min(2.2, this.look.x));
      this.look.lx = e.clientX;
      this.look.ly = e.clientY;
    });
    window.addEventListener('pointerup', () => (this.look.dragging = false));
    window.addEventListener('dblclick', (e) => {
      if (e.target === cvs()) this.look.x = this.look.y = 0;
    });

    // on-screen buttons
    document.querySelectorAll('#touch button').forEach((b) => {
      const act = b.dataset.act;
      const down = (e) => {
        e.preventDefault();
        if (act === 'power') this.delta += 1;
        if (act === 'brake') this.delta -= 1;
        if (act === 'eb') this.eb = true;
        if (act === 'horn') this.touchHorn = true;
        if (act === 'cam') this.camera = true;
        if (act === 'ff') this.ff = true;
      };
      const up = () => {
        if (act === 'horn') this.touchHorn = false;
        if (act === 'ff') this.ff = false;
      };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointerleave', up);
    });
  }

  onKey(e, down) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    const c = e.code;
    if (c === 'F1') {
      if (down) this.help = true;
      e.preventDefault();
      return;
    }
    if (c === 'Escape' || c === 'KeyP') {
      if (down && !e.repeat) this.pause = true;
      return;
    }
    if (!this.enabled) return;
    if (POWER_KEYS.has(c) || BRAKE_KEYS.has(c)) {
      e.preventDefault();
      const dir = POWER_KEYS.has(c) ? 1 : -1;
      if (down && !e.repeat) {
        this.delta += dir;
        this.hold = dir;
        this.holdT = 0;
      } else if (!down && this.hold === dir) this.hold = 0;
      return;
    }
    if (c === 'Space' || c === 'Backspace') {
      e.preventDefault();
      if (down) this.eb = true;
      return;
    }
    if (c === 'KeyN' || c === 'Digit0') {
      if (down) this.neutral = true;
      return;
    }
    if (c === 'KeyH' || c === 'KeyB') {
      this.keyHorn = down;
      return;
    }
    if (c === 'KeyC' || c === 'KeyV') {
      if (down && !e.repeat) this.camera = true;
      return;
    }
    if (c === 'Enter' || c === 'KeyF') {
      this.ff = down;
      e.preventDefault();
    }
  }

  update(dt) {
    if (this.hold) {
      this.holdT += dt;
      if (this.holdT > 0.35) {
        this.holdT -= 0.12;
        this.delta += this.hold;
      }
    }
    // gamepad: left stick / d-pad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      this.padState = this.padState || {};
      const up = p.buttons[12]?.pressed || p.axes[1] < -0.6;
      const dn = p.buttons[13]?.pressed || p.axes[1] > 0.6;
      if (up && !this.padState.up) this.delta += 1;
      if (dn && !this.padState.dn) this.delta -= 1;
      this.padState.up = up;
      this.padState.dn = dn;
      if (p.buttons[0]?.pressed && !this.padState.a) this.eb = true;
      this.padState.a = p.buttons[0]?.pressed;
      this.padHorn = !!p.buttons[1]?.pressed;
      break;
    }
    this.horn = this.keyHorn || this.touchHorn || !!this.padHorn;
  }

  consume() {
    const r = {
      delta: this.delta, eb: this.eb, neutral: this.neutral, camera: this.camera, pause: this.pause, help: this.help,
    };
    this.delta = 0;
    this.eb = this.neutral = this.camera = this.pause = this.help = false;
    return r;
  }
}

// Longitudinal train dynamics with a one-handle master controller.
// notch: -9 = EB, -8..-1 = B8..B1, 0 = N, 1..5 = P1..P5

import { clamp } from './util.js';

export const POWER_FRAC = [0, 0.22, 0.42, 0.62, 0.82, 1.0];
export const G = 9.81;

export function tractionAccel(spec, v, frac) {
  if (frac <= 0) return 0;
  const a0 = spec.accel / 3.6;
  const vb = spec.vBase / 3.6;
  let a = a0 * frac * (v < vb ? 1 : vb / v);
  const vm = (spec.vmax / 3.6) * 1.06;
  if (v > vm * 0.94) a *= clamp((vm - v) / (vm * 0.06), 0, 1);
  return a;
}

export function resistance(v) {
  return 0.012 + 0.00016 * v + 0.000034 * v * v;
}

export function brakeDecel(spec, notch) {
  if (notch >= 0) return 0;
  if (notch <= -9) return spec.eb / 3.6;
  return ((-notch) / 8) * (spec.brake / 3.6);
}

export class TrainPhysics {
  constructor(spec, s0) {
    this.spec = spec;
    this.s = s0;
    this.v = 0;
    this.a = 0;
    this.notch = -8;
    this.powerEff = 0; // 0..1
    this.brakeEff = spec.brake / 3.6; // m/s^2 actual
    this.overrideBrake = 0; // ATP brake (m/s^2)
    this.powerCut = false;
  }

  step(dt, grade) {
    const sp = this.spec;
    const pTarget = this.notch > 0 && !this.powerCut ? POWER_FRAC[this.notch] : 0;
    let bTarget = brakeDecel(sp, this.notch);
    if (this.overrideBrake > bTarget) bTarget = this.overrideBrake;

    this.powerEff += (pTarget - this.powerEff) * Math.min(1, dt / (pTarget > this.powerEff ? 0.45 : 0.25));
    const tau = bTarget > this.brakeEff ? 0.75 : 0.55; // air brake lag
    this.brakeEff += (bTarget - this.brakeEff) * Math.min(1, dt / tau);

    const v = this.v;
    const aT = tractionAccel(sp, v, this.powerEff);
    const aG = -G * grade;
    const aR = v > 0.01 ? resistance(v) : 0;
    let a = aT + aG - aR - this.brakeEff;

    if (v <= 0.0001 && a <= 0) {
      // Holding at standstill (no roll-back modelled)
      this.v = 0;
      this.a = 0;
      return;
    }
    let nv = v + a * dt;
    if (nv < 0) {
      nv = 0;
      a = -v / dt;
    }
    this.s += (v + nv) * 0.5 * dt;
    this.v = nv;
    this.a = a;
  }
}

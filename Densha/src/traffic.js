// Opposite-direction trains on the other track of double-track lines.

import { TrainModel } from './trainmodel.js';
import { TRAINS } from './data.js';
import { RNG, clamp } from './util.js';

const TYPES = [
  ['EMU800', 8, '區間'], ['EMU800', 4, '區間'], ['EMU3000', 12, '自強'], ['TEMU2000', 8, ''], ['E1000', 10, '自強'],
];

export class Traffic {
  constructor(scene, route, env, sound) {
    this.scene = scene;
    this.route = route;
    this.env = env;
    this.sound = sound;
    this.trains = [];
    this.rng = new RNG(route.seed ^ 0x7777);
    this.timer = this.rng.range(15, 40);
  }

  update(dt, playerS, playerV, allowSpawn, night) {
    const r = this.route;
    if (!r.double) return;
    this.timer -= dt;
    if (allowSpawn && this.timer <= 0 && this.trains.length < 2) {
      const rng = this.rng;
      this.timer = rng.range(50, 120);
      const [id, cars, kind] = rng.pick(TYPES);
      const spec = { ...TRAINS[id], cars };
      const s = playerS + rng.range(1500, 2300);
      if (s < r.L - 200) {
        const dest = kind ? `${kind} ${r.stations[0].zh}` : '';
        const model = new TrainModel(spec, { env: this.env, dest });
        model.setHeadlights(true);
        this.scene.add(model.group);
        this.trains.push({ model, s, v: (rng.range(80, 120) / 3.6) * (id === 'EMU800' ? 0.85 : 1), len: cars * 20 + 2 * spec.noseLen, passed: false });
      }
    }
    for (let i = this.trains.length - 1; i >= 0; i--) {
      const t = this.trains[i];
      t.s -= t.v * dt;
      t.model.place(r, t.s, -1, 4);
      if (!t.passed && t.s < playerS) {
        t.passed = true;
        this.sound.passBy(clamp(0.25 + (t.v + playerV) / 80, 0.2, 0.9));
      }
      if (t.s + t.len < playerS - 700 || t.s < -300) {
        t.model.dispose();
        this.trains.splice(i, 1);
      }
    }
  }

  dispose() {
    for (const t of this.trains) t.model.dispose();
    this.trains = [];
  }
}

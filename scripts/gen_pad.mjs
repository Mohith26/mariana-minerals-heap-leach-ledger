// Synthetic heap-leach pad (seeded). Exports makePad(seed) for the calibration
// study; run directly to write data/pad.json.
import { writeFileSync, mkdirSync } from 'node:fs';
import { mulberry32, gauss, priorOf, moduleForward, QREF, SIGMA_PLS, SIGMA_DRIP, expit } from '../core/leach.mjs';

export const START = '2025-12-15';
export const DAYS = 330; // through 2026-11-09
const COLS = 6, ROWS = 4;

export function rotationQ(m, t, r) {
  const age = t - m.stack;
  if (age < 0) return 0;
  if (age < 120) return age % 8 === 7 ? 0 : QREF * (0.92 + 0.16 * r());
  if (age < 180) return 0.4 * QREF * (0.9 + 0.2 * r());
  return 0;
}

export function makePad(seed, opts = {}) {
  const r = mulberry32(seed);
  const types = ['oxide', 'oxide', 'oxide', 'oxide', 'mixed', 'mixed', 'mixed', 'mixed', 'sulfide', 'sulfide', 'sulfide', 'sulfide'];
  const modules = [];
  for (let e = 0; e < 12; e++) {
    for (const side of [0, 1]) {
      const idx = modules.length;
      const col = idx % COLS, row = Math.floor(idx / COLS);
      const type = types[e];
      const pr = priorOf(type);
      const tonnage = Math.round(70000 + 40000 * r());
      const grade = +(0.28 + 0.27 * r()).toFixed(3);
      const m = { id: `M-${String(idx + 1).padStart(2, '0')}`, row, col, type, tonnage, grade, cuKg: tonnage * grade * 10, stack: e * 26 + side * 2 + Math.floor(3 * r()), q: [] };
      m.truth = { a: pr.ma + pr.sa * gauss(r), b: pr.mb + pr.sb * gauss(r) };
      modules.push(m);
    }
  }
  if (!opts.noAnomalies) {
    modules[14].truth.b += Math.log(0.35); modules[14].note = 'channeling suspected';
    modules[8].truth.a -= 0.9; modules[8].note = 'block-model grade likely overstated';
  }
  for (const m of modules) { const rr = mulberry32(seed ^ (m.stack * 7919 + m.col * 31 + m.row)); m.q = Array.from({ length: DAYS }, (_, t) => Math.round(rotationQ(m, t, rr))); }
  // truth forward
  const y = new Float64Array(DAYS); const fw = modules.map((m) => moduleForward(m.truth.a, m.truth.b, m.q, m.cuKg, m.stack));
  fw.forEach((f) => { for (let t = 0; t < DAYS; t++) y[t] += f.y[t]; });
  const plsDays = [], plsObs = new Array(DAYS).fill(null), flow = [];
  for (let t = 0; t < DAYS; t++) {
    const F = modules.reduce((s, m) => s + m.q[t], 0); flow.push(Math.round(F));
    if (y[t] > 100) { plsDays.push(t); plsObs[t] = +(y[t] * Math.exp(SIGMA_PLS * gauss(r))).toFixed(1); }
  }
  // drip samples: about 1.5 per week, at a random irrigated module
  const drips = [];
  for (let t = 10; t < DAYS; t++) {
    if (r() > 1.5 / 7) continue;
    const act = modules.map((m, i) => i).filter((i) => modules[i].q[t] > 0 && fw[i].y[t] > 1);
    if (!act.length) continue;
    const i = act[Math.floor(r() * act.length)];
    drips.push({ t, i, c: +((fw[i].y[t] / modules[i].q[t]) * Math.exp(SIGMA_DRIP * gauss(r))).toFixed(4) });
  }
  const truthNow = fw.map((f, i) => ({ R: f.R[DAYS - 1], rInf: expit(modules[i].truth.a), k: Math.exp(modules[i].truth.b) }));
  return { seed, start: START, days: DAYS, cols: COLS, rows: ROWS, modules, plsDays, plsObs, flow, drips, truthNow };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pad = makePad(20261109);
  mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../data/pad.json', import.meta.url), JSON.stringify(pad));
  console.log('modules', pad.modules.length, 'PLS days', pad.plsDays.length, 'drips', pad.drips.length);
}

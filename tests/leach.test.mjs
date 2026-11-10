import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { moduleForward, KERNEL, fitPad, mcmcDraws, ledgerFor, allocate, evalPlan, gainT, dripValue, updateCov, cholesky, solveChol, invertSPD, quantile, QREF, expit, priorOf } from '../core/leach.mjs';
import { makePad } from '../scripts/gen_pad.mjs';
import { runLedger, rotationPlan, PLAN_CFG } from '../core/pipeline.mjs';

test('travel-time kernel is a normalized distribution with mean near 4 days', () => {
  const s = KERNEL.reduce((a, b) => a + b, 0), mean = KERNEL.reduce((a, h, l) => a + h * (l + 0.5), 0);
  assert.ok(Math.abs(s - 1) < 1e-12); assert.ok(Math.abs(mean - 4) < 0.3, `mean ${mean}`);
});

test('module forward model conserves copper and saturates at the ultimate recovery', () => {
  const q = Array(2000).fill(QREF), cu = 400000;
  const f = moduleForward(Math.log(0.7 / 0.3), Math.log(0.03), q, cu, 0);
  const dissolved = f.d.reduce((a, b) => a + b, 0), arrived = f.y.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(f.R[1999] - 0.7) < 1e-6);
  assert.ok(Math.abs(dissolved - 0.7 * cu) < 1e-3);
  assert.ok(Math.abs(arrived - dissolved) / dissolved < 1e-6, 'everything dissolved reaches PLS after the kernel');
  const g = moduleForward(Math.log(0.7 / 0.3), Math.log(0.03), Array(100).fill(0), cu, 0);
  assert.equal(g.R[99], 0, 'no irrigation, no leaching');
});

test('linear algebra helpers', () => {
  const A = [[4, 2, 0.4], [2, 5, 1], [0.4, 1, 3]];
  const x = solveChol(cholesky(A), [1, 2, 3]);
  const back = A.map((r) => r.reduce((s, a, j) => s + a * x[j], 0));
  back.forEach((v, i) => assert.ok(Math.abs(v - [1, 2, 3][i]) < 1e-12));
  const inv = invertSPD(A); const I = A.map((r, i) => A.map((_, j) => r.reduce((s, a, k) => s + a * inv[k][j], 0)));
  I.forEach((r, i) => r.forEach((v, j) => assert.ok(Math.abs(v - (i === j ? 1 : 0)) < 1e-12)));
});

test('fit recovers per-module copper from the combined stream (synthetic pad)', () => {
  const pad = makePad(4242, { noAnomalies: true });
  const fit = fitPad(pad);
  const L = ledgerFor(fit.theta, pad);
  let err = 0, tot = 0;
  pad.modules.forEach((m, i) => { const tr = pad.truthNow[i]; const t = (m.cuKg * (tr.rInf - tr.R)) / 1000; err += Math.abs(L[i].remainingT - t); tot += t; });
  assert.ok(err / tot < 0.3, `relative abs error ${err / tot}`);
  assert.ok(fit.trace.every((c, k) => k === 0 || c <= fit.trace[k - 1] + 1e-9), 'LM cost never increases');
});

test('MCMC draws stay near the MAP and have sane acceptance', () => {
  const pad = makePad(7, { noAnomalies: true }); const fit = fitPad(pad);
  const mc = mcmcDraws(fit, pad, 100, 3, { sweeps: 600, burn: 200 });
  assert.equal(mc.draws.length, 100);
  assert.ok(mc.acceptance > 0.15 && mc.acceptance < 0.6, `acceptance ${mc.acceptance}`);
  const a0 = mc.draws.map((d) => d[46]); assert.ok(Math.abs(quantile(a0, 0.5) - fit.theta[46]) < 0.5);
});

test('allocation respects the pump cap and beats rotation in expectation; equals brute force on a 2-module toy', () => {
  const pad = JSON.parse(readFileSync(new URL('../data/pad.json', import.meta.url)));
  const fit = fitPad(pad), draws = mcmcDraws(fit, pad, 60, 9, { sweeps: 500, burn: 200 }).draws;
  const states = draws.map((th) => ledgerFor(th, pad).map((x) => x.recovered));
  const q = allocate(pad, draws, states, PLAN_CFG);
  assert.ok(q.reduce((a, b) => a + b, 0) <= PLAN_CFG.Qcap + 1);
  assert.ok(q.every((x) => x >= 0 && x <= PLAN_CFG.qmax + 1e-9));
  const net = (qq) => { const g = evalPlan(pad, draws, states, qq, 14); return (g.reduce((a, b) => a + b, 0) / g.length) * PLAN_CFG.cuPrice - PLAN_CFG.costPerM3 * qq.reduce((a, b) => a + b, 0) * 14; };
  assert.ok(net(q) >= net(rotationPlan(pad, PLAN_CFG.Qcap)) - 1e-6);
  // toy: two modules, brute-force grid
  const toy = { days: 10, modules: [{ stack: 0, q: [], cuKg: 3e5, retired: false }, { stack: 0, q: [], cuKg: 1e5, retired: false }] };
  const th = [[Math.log(0.6 / 0.4), Math.log(0.02), Math.log(0.8 / 0.2), Math.log(0.05)]], st = [[0.1, 0.2]];
  const cfg = { Qcap: 1200, qmax: 1440, days: 14, costPerM3: 0.45, cuPrice: 9650 };
  const qa = allocate(toy, th, st, cfg);
  const val = (a, b) => (gainT(toy.modules[0], th[0], 0, 0.1, a, 14) + gainT(toy.modules[1], th[0], 1, 0.2, b, 14)) * 9650 - 0.45 * (a + b) * 14;
  let best = -Infinity; for (let a = 0; a <= 1200; a += 5) for (let b = 0; b <= 1200 - a; b += 5) best = Math.max(best, val(a, b));
  assert.ok(val(qa[0], qa[1]) >= best - 50, `${val(qa[0], qa[1])} vs ${best}`);
});

test('drip-sample value of information matches an explicit rank-one posterior update', () => {
  const pad = JSON.parse(readFileSync(new URL('../data/pad.json', import.meta.url)));
  const fit = fitPad(pad), j = 22, w = new Float64Array(fit.theta.length); w[2 * j] = 1; w[2 * j + 1] = 0.5;
  const dv = dripValue(fit, pad, w, j, QREF);
  const C2 = updateCov(fit.cov, dv.a, j);
  const v = (C) => { let s = 0; for (let a = 0; a < w.length; a++) for (let b = 0; b < w.length; b++) s += w[a] * C[a][b] * w[b]; return s; };
  assert.ok(Math.abs(v(fit.cov) - v(C2) - dv.reduction) < 1e-9 * Math.max(1, dv.reduction));
  assert.ok(dv.reduction > 0);
  assert.equal(dripValue(fit, pad, w, j, 0).reduction, 0, 'cannot sample a dry module');
});

test('committed results reproduce from the committed pad', () => {
  const pad = JSON.parse(readFileSync(new URL('../data/pad.json', import.meta.url)));
  const ref = JSON.parse(readFileSync(new URL('../data/results.json', import.meta.url)));
  const res = runLedger(pad);
  assert.deepEqual(res.total, ref.total); assert.deepEqual(res.plan.uplift, ref.plan.uplift); assert.deepEqual(res.voi.picks.map((p) => p.id), ref.voi.picks.map((p) => p.id));
});

test('planted anomalies are the modules flagged off-prior', () => {
  const ref = JSON.parse(readFileSync(new URL('../data/results.json', import.meta.url)));
  const flagged = ref.modules.filter((m) => m.anomaly).map((m) => m.id).sort();
  assert.deepEqual(flagged, ['M-09', 'M-15']);
});

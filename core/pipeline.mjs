// End-to-end ledger run used by the page, the batch script and the tests.
import { fitPad, mcmcDraws, ledgerFor, quantile, allocate, evalPlan, dripValue, updateCov, remainingGrad, padForward, moduleForward, QREF, expit, priorOf, gainT } from './leach.mjs';

export const PLAN_CFG = { Qcap: 8100, qmax: 1.6 * QREF, days: 14, costPerM3: 0.45, cuPrice: 9650 };

export function rotationPlan(pad, Qcap) {
  const t = pad.days;
  const q = pad.modules.map((m) => { const age = t - m.stack; return age < 0 ? 0 : age < 120 ? QREF : age < 180 ? 0.4 * QREF : 0; });
  const s = q.reduce((a, b) => a + b, 0);
  return s > Qcap ? q.map((x) => (x * Qcap) / s) : q;
}

export function runLedger(pad, cfg = {}) {
  const S = cfg.draws ?? 300, seed = cfg.seed ?? 20261109;
  const t0 = Date.now();
  const fit = fitPad(pad);
  const mc = mcmcDraws(fit, pad, S, seed, cfg.mcmc);
  const draws = mc.draws;
  const L = draws.map((th) => ledgerFor(th, pad));
  const states = L.map((l) => l.map((x) => x.recovered));
  const now = pad.days - 1;
  const modules = pad.modules.map((m, i) => {
    const rem = L.map((l) => l[i].remainingT), rinf = L.map((l) => l[i].rInf), kk = L.map((l) => l[i].k), rec = L.map((l) => l[i].recovered);
    const pr = priorOf(m.type);
    const zA = (fit.theta[2 * i] - pr.ma) / pr.sa, zB = (fit.theta[2 * i + 1] - pr.mb) / pr.sb;
    return {
      id: m.id, i, rem: [quantile(rem, 0.05), quantile(rem, 0.5), quantile(rem, 0.95)], rInf: [quantile(rinf, 0.05), quantile(rinf, 0.5), quantile(rinf, 0.95)],
      k: [quantile(kk, 0.05), quantile(kk, 0.5), quantile(kk, 0.95)], recovered: quantile(rec, 0.5), drainedT: L[0][i].drainedT,
      zA, zB, anomaly: Math.abs(zA) > 1.8 ? (zA < 0 ? 'low ultimate recovery vs column tests' : 'high ultimate recovery vs column tests') : Math.abs(zB) > 1.8 ? (zB < 0 ? 'slow kinetics vs column tests (channeling or ponding?)' : 'fast kinetics vs column tests') : null,
      nDrips: pad.drips.filter((d) => d.i === i).length, irrigatedNow: m.q[now] > 0,
    };
  });
  const totals = L.map((l) => l.reduce((s, x) => s + x.remainingT, 0));
  const total = [quantile(totals, 0.05), quantile(totals, 0.5), quantile(totals, 0.95)];
  // attribution: posterior-median contribution of each module to the PLS stream, plus predictive band of the total
  const contrib = pad.modules.map((m, i) => { const y = moduleForward(fit.theta[2 * i], fit.theta[2 * i + 1], m.q, m.cuKg, m.stack).y; return Array.from(y, (v) => +(v / 1000).toFixed(4)); });
  const band = [];
  const sub = draws.filter((_, d) => d % 6 === 0).map((th) => padForward(th, pad).y);
  for (let t = 0; t < pad.days; t++) { const col = sub.map((y) => y[t] / 1000); band.push([quantile(col, 0.05), quantile(col, 0.95)]); }
  // plans
  const P = { ...PLAN_CFG, ...(cfg.plan || {}) };
  const qPlan = allocate(pad, draws, states, P);
  const qRot = rotationPlan(pad, P.Qcap);
  const gPlan = evalPlan(pad, draws, states, qPlan, P.days), gRot = evalPlan(pad, draws, states, qRot, P.days);
  const diff = gPlan.map((g, d) => g - gRot[d]);
  const waterPlan = qPlan.reduce((a, b) => a + b, 0), waterRot = qRot.reduce((a, b) => a + b, 0);
  const plan = {
    cfg: P, qPlan, qRot, waterPlan, waterRot,
    gainPlan: [quantile(gPlan, 0.05), quantile(gPlan, 0.5), quantile(gPlan, 0.95)], gainRot: [quantile(gRot, 0.05), quantile(gRot, 0.5), quantile(gRot, 0.95)],
    uplift: [quantile(diff, 0.05), quantile(diff, 0.5), quantile(diff, 0.95)], pBetter: diff.filter((x) => x > 0).length / diff.length,
    perModule: pad.modules.map((m, i) => { const gp = draws.map((th, d) => gainT(m, th, i, states[d][i], qPlan[i], P.days)), gr = draws.map((th, d) => gainT(m, th, i, states[d][i], qRot[i], P.days)); return { plan: quantile(gp, 0.5), rot: quantile(gr, 0.5), planLo: quantile(gp, 0.05), planHi: quantile(gp, 0.95) }; }),
  };
  // value of information: next three drip samples (greedy, rank-one updates)
  const w = remainingGrad(fit.theta, pad);
  let C = fit.cov.map((r) => r.slice());
  const varQ = (Cm) => { let s = 0; for (let a = 0; a < w.length; a++) { if (!w[a]) continue; for (let b = 0; b < w.length; b++) s += w[a] * Cm[a][b] * w[b]; } return s; };
  const v0 = varQ(C);
  const ranking = pad.modules.map((m, j) => ({ j, id: m.id, red: dripValue({ ...fit, cov: C }, pad, w, j, qPlan[j]).reduction })).filter((x) => x.red > 0).sort((a, b) => b.red - a.red);
  const picks = []; const used = new Set();
  for (let k = 0; k < 3; k++) {
    let best = null;
    for (let j = 0; j < pad.modules.length; j++) { if (used.has(j) || !(qPlan[j] > 0)) continue; const dv = dripValue({ ...fit, cov: C }, pad, w, j, qPlan[j]); if (!best || dv.reduction > best.dv.reduction) best = { j, dv }; }
    if (!best || best.dv.reduction <= 0) break;
    const before = Math.sqrt(varQ(C));
    C = updateCov(C, best.dv.a, best.j); used.add(best.j);
    // which other module's remaining copper sd drops most (shared PLS signal)
    const after = Math.sqrt(varQ(C));
    picks.push({ id: pad.modules[best.j].id, j: best.j, sdBefore: before, sdAfter: after });
  }
  const sdAll = Math.sqrt(v0);
  // posterior correlation of remaining copper between module pairs (attribution confounding)
  const remMat = pad.modules.map((_, i) => L.map((l) => l[i].remainingT));
  const corr = (x, y) => { const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n; let sxy = 0, sxx = 0, syy = 0; for (let k = 0; k < n; k++) { sxy += (x[k] - mx) * (y[k] - my); sxx += (x[k] - mx) ** 2; syy += (y[k] - my) ** 2; } return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0; };
  let worstPair = null;
  for (let a = 0; a < remMat.length; a++) for (let b = a + 1; b < remMat.length; b++) { const c = corr(remMat[a], remMat[b]); if (!worstPair || c < worstPair.c) worstPair = { a: pad.modules[a].id, b: pad.modules[b].id, c }; }
  return { ms: Date.now() - t0, fit: { cost: fit.cost, iters: fit.iters, nResid: fit.nResid, theta: fit.theta }, mcmc: { acceptance: mc.acceptance, sweeps: mc.sweeps, burn: mc.burn, draws: draws.length }, modules, total, contrib, band, plan, voi: { sdTotal: sdAll, picks, ranking: ranking.slice(0, 8) }, worstPair, drawsSample: draws.slice(0, 60) };
}

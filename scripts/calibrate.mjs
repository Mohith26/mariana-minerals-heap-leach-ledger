// Calibration study: 40 synthetic pads (same generator, different seeds),
// full fit each time; how often do the 90% intervals contain the truth?
import { writeFileSync } from 'node:fs';
import { makePad, rotationQ } from './gen_pad.mjs';
import { fitPad, sampleTheta, mcmcDraws, ledgerFor, quantile, gainT, mulberry32 } from '../core/leach.mjs';

const R = +(process.argv[2] || 40), out = { reps: [] };
let essSum = 0; let modIn = 0, modN = 0, totIn = 0, gainIn = 0, gainN = 0;
for (let k = 0; k < R; k++) {
  const pad = makePad(1000 + k, { noAnomalies: process.env.NOANOM === '1' });
  const fit = fitPad(pad); const pd = process.env.LAPLACE === '1' ? { draws: sampleTheta(fit, 300, 77 + k), ess: 300 } : mcmcDraws(fit, pad, 300, 77 + k); const S = pd.draws, L = S.map((th) => ledgerFor(th, pad)); essSum += pd.acceptance ?? 0;
  let trueTot = 0;
  pad.modules.forEach((m, i) => {
    const tr = pad.truthNow[i], trem = (m.cuKg * (tr.rInf - tr.R)) / 1000; trueTot += trem;
    if (m.stack > pad.days - 15) return;
    const rem = L.map((l) => l[i].remainingT); const lo = quantile(rem, 0.05), hi = quantile(rem, 0.95);
    modN++; if (trem >= lo - 1e-9 && trem <= hi + 1e-9) modIn++;
    // 14-day gain at the reference rate
    const th = [], tth = [];
    const g = S.map((s, d) => gainT(m, s, i, L[d][i].recovered, 900, 14));
    const truthTheta = []; truthTheta[2 * i] = m.truth.a; truthTheta[2 * i + 1] = m.truth.b;
    const tg = gainT(m, truthTheta, i, tr.R, 900, 14);
    if (tg > 0.5) { gainN++; if (tg >= quantile(g, 0.05) && tg <= quantile(g, 0.95)) gainIn++; }
  });
  const T = L.map((l) => l.reduce((s, x) => s + x.remainingT, 0));
  const inT = trueTot >= quantile(T, 0.05) && trueTot <= quantile(T, 0.95); if (inT) totIn++;
  out.reps.push({ seed: 1000 + k, total: [quantile(T, 0.05), quantile(T, 0.5), quantile(T, 0.95)].map((x) => +x.toFixed(1)), truth: +trueTot.toFixed(1), inT });
}
out.summary = { method: process.env.LAPLACE === '1' ? 'laplace' : 'block-MwG', meanAcceptance: essSum / R, pads: R, moduleIntervals: modN, moduleCoverage90: modIn / modN, padTotalCoverage90: totIn / R, gainIntervals: gainN, gainCoverage90: gainIn / gainN };
writeFileSync(new URL('../data/calibration.json', import.meta.url), JSON.stringify(out));
console.log(out.summary);

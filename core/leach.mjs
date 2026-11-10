// Heap-leach pad copper ledger: per-module recovery inferred from the
// combined PLS stream, value-of-information drip sampling, and a
// posterior-expected irrigation allocation. Dependency-free.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

// Column-test priors by ore type (fraction of block-model acid-soluble Cu
// that is ultimately recoverable, and first-order rate per day at the
// reference irrigation rate).
export const ORE = {
  oxide: { label: 'Oxide', rInf: 0.82, k: 0.04, sdA: 0.45, sdB: 0.45 },
  mixed: { label: 'Mixed', rInf: 0.68, k: 0.022, sdA: 0.45, sdB: 0.45 },
  sulfide: { label: 'Chalcocite', rInf: 0.58, k: 0.011, sdA: 0.45, sdB: 0.45 },
};
export const QREF = 900; // m3/day per module at the design application rate
export const SIGMA_PLS = 0.04; // log-sd of daily net Cu transfer (flow x grade)
export const SIGMA_DRIP = 0.1; // log-sd of a module drip sample assay

const logit = (p) => Math.log(p / (1 - p));
const expit = (x) => 1 / (1 + Math.exp(-x));
export function priorOf(type) { const o = ORE[type]; return { ma: logit(o.rInf), mb: Math.log(o.k), sa: o.sdA, sb: o.sdB }; }

// Solution travel time from the module to the PLS ditch: discrete gamma,
// mean 4 days, shape 3, truncated at 20 days.
export const KERNEL = (() => {
  const shape = 3, mean = 4, scale = mean / shape, L = 21, h = [];
  const pdf = (x) => Math.pow(x, shape - 1) * Math.exp(-x / scale);
  for (let l = 0; l < L; l++) h.push(pdf(l + 0.5));
  const s = h.reduce((a, b) => a + b, 0); return h.map((x) => x / s);
})();

// Forward model for one module. q: daily irrigation (m3/day) over the
// horizon; cuKg: block-model contained acid-soluble Cu (kg).
// Returns recovery R[t] (end of day), dissolved Cu per day and Cu arriving in PLS per day.
export function moduleForward(a, b, q, cuKg, stack) {
  const n = q.length, rInf = expit(a), k = Math.exp(b);
  const R = new Float64Array(n), d = new Float64Array(n), y = new Float64Array(n);
  let r = 0;
  for (let t = 0; t < n; t++) {
    if (t >= stack && q[t] > 0) {
      const u = Math.sqrt(q[t] / QREF);
      const rn = rInf - (rInf - r) * Math.exp(-k * u);
      d[t] = cuKg * (rn - r); r = rn;
    }
    R[t] = r;
  }
  for (let t = 0; t < n; t++) { let s = 0; for (let l = 0; l < KERNEL.length && l <= t; l++) s += KERNEL[l] * d[t - l]; y[t] = s; }
  return { R, d, y };
}

export function padForward(theta, pad) {
  const mods = pad.modules.map((m, i) => moduleForward(theta[2 * i], theta[2 * i + 1], m.q, m.cuKg, m.stack));
  const n = pad.days, y = new Float64Array(n);
  for (const f of mods) for (let t = 0; t < n; t++) y[t] += f.y[t];
  return { mods, y };
}

// residual vector: PLS days, drip samples, priors
function residuals(theta, pad, fw) {
  const r = [];
  const f = fw || padForward(theta, pad);
  for (const t of pad.plsDays) r.push((Math.log(pad.plsObs[t]) - Math.log(Math.max(f.y[t], 1e-6))) / SIGMA_PLS);
  for (const s of pad.drips) {
    const m = pad.modules[s.i], c = f.mods[s.i].y[s.t] / m.q[s.t];
    r.push((Math.log(s.c) - Math.log(Math.max(c, 1e-9))) / SIGMA_DRIP);
  }
  pad.modules.forEach((m, i) => { const p = priorOf(m.type); r.push((theta[2 * i] - p.ma) / p.sa); r.push((theta[2 * i + 1] - p.mb) / p.sb); });
  return { r, f };
}

// Jacobian by forward differences; each parameter only touches its module.
function jacobian(theta, pad, f) {
  const P = theta.length, nP = pad.plsDays.length, nD = pad.drips.length, N = nP + nD + P;
  const J = Array.from({ length: N }, () => new Float64Array(P));
  const h = 1e-5;
  for (let p = 0; p < P; p++) {
    const i = p >> 1, m = pad.modules[i];
    const a = theta[2 * i] + (p % 2 === 0 ? h : 0), b = theta[2 * i + 1] + (p % 2 === 1 ? h : 0);
    const g = moduleForward(a, b, m.q, m.cuKg, m.stack);
    pad.plsDays.forEach((t, j) => {
      const y0 = Math.max(f.y[t], 1e-6), y1 = Math.max(f.y[t] - f.mods[i].y[t] + g.y[t], 1e-6);
      J[j][p] = -(Math.log(y1) - Math.log(y0)) / h / SIGMA_PLS;
    });
    pad.drips.forEach((s, j) => {
      if (s.i !== i) return;
      const c0 = Math.max(f.mods[i].y[s.t], 1e-9), c1 = Math.max(g.y[s.t], 1e-9);
      J[nP + j][p] = -(Math.log(c1) - Math.log(c0)) / h / SIGMA_DRIP;
    });
    const pr = priorOf(m.type);
    J[nP + nD + p][p] = 1 / (p % 2 === 0 ? pr.sa : pr.sb);
  }
  return J;
}

export function cholesky(A) {
  const n = A.length, L = A.map(() => new Float64Array(n));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i][j]; for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    if (i === j) { if (s <= 0) throw new Error('not positive definite'); L[i][j] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
  }
  return L;
}
export function solveChol(L, b) {
  const n = L.length, y = new Float64Array(n), x = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
  return x;
}
export function invertSPD(A) { const L = cholesky(A), n = A.length, inv = A.map(() => new Float64Array(n)); for (let j = 0; j < n; j++) { const e = new Float64Array(n); e[j] = 1; const c = solveChol(L, e); for (let i = 0; i < n; i++) inv[i][j] = c[i]; } return inv; }

// MAP by Levenberg-Marquardt, then Laplace approximation (Gauss-Newton Hessian).
export function fitPad(pad, cfg = {}) {
  const P = pad.modules.length * 2;
  let theta = new Float64Array(P);
  pad.modules.forEach((m, i) => { const p = priorOf(m.type); theta[2 * i] = p.ma; theta[2 * i + 1] = p.mb; });
  let { r, f } = residuals(theta, pad);
  let cost = r.reduce((s, x) => s + x * x, 0), lam = 1e-2, it = 0;
  const trace = [cost];
  for (; it < (cfg.maxIter ?? 60); it++) {
    const J = jacobian(theta, pad, f);
    const A = Array.from({ length: P }, () => new Float64Array(P)), g = new Float64Array(P);
    for (let n = 0; n < J.length; n++) { const row = J[n], rn = r[n]; for (let a = 0; a < P; a++) { if (!row[a]) continue; g[a] += row[a] * rn; for (let b = 0; b < P; b++) if (row[b]) A[a][b] += row[a] * row[b]; } }
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const M = A.map((row, a) => { const c = Float64Array.from(row); c[a] *= 1 + lam; return c; });
      const step = solveChol(cholesky(M), g);
      const cand = theta.map((x, a) => x - step[a]);
      const res = residuals(cand, pad); const c2 = res.r.reduce((s, x) => s + x * x, 0);
      if (c2 < cost) { theta = cand; r = res.r; f = res.f; const rel = (cost - c2) / cost; cost = c2; lam = Math.max(lam / 3, 1e-7); improved = true; if (rel < 1e-9) it = 1e9; break; }
      lam *= 4;
    }
    trace.push(cost);
    if (!improved) break;
  }
  const J = jacobian(theta, pad, f);
  const H = Array.from({ length: P }, () => new Float64Array(P));
  for (const row of J) for (let a = 0; a < P; a++) { if (!row[a]) continue; for (let b = 0; b < P; b++) if (row[b]) H[a][b] += row[a] * row[b]; }
  const cov = invertSPD(H);
  return { theta: Array.from(theta), cov: cov.map((r) => Array.from(r)), cost, nResid: r.length, iters: trace.length - 1, trace, fw: f };
}

// Exact posterior draws: block Metropolis-within-Gibbs, one (a, b) block per
// module, started at the MAP, with proposals shaped by the Laplace marginal
// covariance of the block and a scale adapted during burn-in. A block update
// only re-simulates its own module, so a sweep is cheap.
export function mcmcDraws(fit, pad, S, seed, opts = {}) {
  const sweeps = opts.sweeps ?? 1500, burn = opts.burn ?? 500, M = pad.modules.length, n = pad.days;
  const r = mulberry32(seed);
  const th = fit.theta.slice();
  const ys = pad.modules.map((m, i) => moduleForward(th[2 * i], th[2 * i + 1], m.q, m.cuKg, m.stack).y);
  const tot = new Float64Array(n); for (const y of ys) for (let t = 0; t < n; t++) tot[t] += y[t];
  const dripsOf = pad.modules.map((_, i) => pad.drips.filter((d) => d.i === i));
  const pls = pad.plsDays;
  const plsCost = (Y) => { let c = 0; for (const t of pls) { const e = (Math.log(pad.plsObs[t]) - Math.log(Math.max(Y[t], 1e-6))) / SIGMA_PLS; c += e * e; } return c; };
  const blockCost = (i, a, b, y) => {
    const m = pad.modules[i], p = priorOf(m.type); let c = ((a - p.ma) / p.sa) ** 2 + ((b - p.mb) / p.sb) ** 2;
    for (const d of dripsOf[i]) { const e = (Math.log(d.c) - Math.log(Math.max(y[d.t] / m.q[d.t], 1e-9))) / SIGMA_DRIP; c += e * e; }
    return c;
  };
  let curPls = plsCost(tot);
  const bc = pad.modules.map((_, i) => blockCost(i, th[2 * i], th[2 * i + 1], ys[i]));
  const chol2 = pad.modules.map((_, i) => { const c = fit.cov; const s11 = c[2 * i][2 * i], s12 = c[2 * i][2 * i + 1], s22 = c[2 * i + 1][2 * i + 1]; const l11 = Math.sqrt(s11), l21 = s12 / l11, l22 = Math.sqrt(Math.max(s22 - l21 * l21, 1e-12)); return [l11, l21, l22]; });
  const scale = new Array(M).fill(1.2), acc = new Array(M).fill(0), tries = new Array(M).fill(0);
  const out = [], every = Math.max(1, Math.floor((sweeps - burn) / S));
  const cand = new Float64Array(n);
  for (let sw = 0; sw < sweeps; sw++) {
    for (let i = 0; i < M; i++) {
      const [l11, l21, l22] = chol2[i], z1 = gauss(r), z2 = gauss(r), sc = scale[i];
      const a = th[2 * i] + sc * l11 * z1, b = th[2 * i + 1] + sc * (l21 * z1 + l22 * z2);
      const m = pad.modules[i];
      const y = moduleForward(a, b, m.q, m.cuKg, m.stack).y;
      for (let t = 0; t < n; t++) cand[t] = tot[t] - ys[i][t] + y[t];
      const nb = blockCost(i, a, b, y), np = plsCost(cand);
      const dl = -0.5 * (nb + np - bc[i] - curPls);
      tries[i]++;
      if (Math.log(r()) < dl) { th[2 * i] = a; th[2 * i + 1] = b; ys[i] = y; tot.set(cand); bc[i] = nb; curPls = np; acc[i]++; }
    }
    if (sw < burn && sw % 50 === 49) for (let i = 0; i < M; i++) { const rate = acc[i] / tries[i]; scale[i] *= rate > 0.4 ? 1.25 : rate < 0.25 ? 0.8 : 1; acc[i] = 0; tries[i] = 0; }
    if (sw >= burn && (sw - burn) % every === 0 && out.length < S) out.push(th.slice());
  }
  const rate = acc.reduce((x, y) => x + y, 0) / Math.max(1, tries.reduce((x, y) => x + y, 0));
  return { draws: out, acceptance: rate, sweeps, burn };
}

export function sampleTheta(fit, S, seed) {
  const L = cholesky(fit.cov.map((r) => Float64Array.from(r))), P = fit.theta.length, r = mulberry32(seed), out = [];
  for (let s = 0; s < S; s++) { const z = Array.from({ length: P }, () => gauss(r)); const v = fit.theta.map((m, i) => { let x = m; for (let k = 0; k <= i; k++) x += L[i][k] * z[k]; return x; }); out.push(v); }
  return out;
}

// Ledger quantities per module for one parameter vector.
export function ledgerFor(theta, pad) {
  const now = pad.days - 1;
  return pad.modules.map((m, i) => {
    const f = moduleForward(theta[2 * i], theta[2 * i + 1], m.q, m.cuKg, m.stack);
    const rInf = expit(theta[2 * i]);
    const Rn = f.R[now];
    return { rInf, k: Math.exp(theta[2 * i + 1]), recovered: Rn, remainingT: (m.cuKg * (rInf - Rn)) / 1000, drainedT: f.y.reduce((a, b) => a + b, 0) / 1000 };
  });
}

export function quantile(arr, q) { const b = Float64Array.from(arr).sort(); const p = (b.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return b[lo] + (b[hi] - b[lo]) * (p - lo); }

// Copper dissolved over a horizon from the current state under constant
// irrigation q (m3/day); concave in q.
export function gainT(m, theta, i, Rn, q, days) {
  if (q <= 0) return 0;
  const rInf = expit(theta[2 * i]), k = Math.exp(theta[2 * i + 1]);
  return (m.cuKg * (rInf - Rn) * (1 - Math.exp(-k * Math.sqrt(q / QREF) * days))) / 1000;
}

// Posterior-expected allocation of a pumping budget across modules:
// maximize E[sum_i gain_i(q_i)] - cost * sum q_i * days subject to
// sum q_i <= Qcap, 0 <= q_i <= qmax. Separable concave: bisection on the
// Lagrange multiplier, golden-section per module.
export function allocate(pad, draws, states, cfg) {
  const { Qcap, qmax, days, costPerM3, cuPrice } = cfg;
  const eligible = pad.modules.map((m, i) => m.stack <= pad.days - 1 && !m.retired);
  const val = (i, q) => { let s = 0; for (let d = 0; d < draws.length; d++) s += gainT(pad.modules[i], draws[d], i, states[d][i], q, days); return (s / draws.length) * cuPrice - costPerM3 * q * days; };
  const best = (i, mu) => {
    if (!eligible[i]) return 0;
    let lo = 0, hi = qmax; const phi = (Math.sqrt(5) - 1) / 2;
    const F = (q) => val(i, q) - mu * q * days;
    let x1 = hi - phi * (hi - lo), x2 = lo + phi * (hi - lo), f1 = F(x1), f2 = F(x2);
    for (let it = 0; it < 40; it++) { if (f1 < f2) { lo = x1; x1 = x2; f1 = f2; x2 = lo + phi * (hi - lo); f2 = F(x2); } else { hi = x2; x2 = x1; f2 = f1; x1 = hi - phi * (hi - lo); f1 = F(x1); } }
    const q = (lo + hi) / 2; return F(q) > F(0) ? q : 0;
  };
  let lo = 0, hi = 50; let q = pad.modules.map((_, i) => best(i, 0));
  if (q.reduce((a, b) => a + b, 0) > Qcap) {
    for (let it = 0; it < 50; it++) { const mid = (lo + hi) / 2; const qm = pad.modules.map((_, i) => best(i, mid)); if (qm.reduce((a, b) => a + b, 0) > Qcap) lo = mid; else { hi = mid; q = qm; } }
  }
  return q;
}

// Evaluate a plan under every posterior draw: copper dissolved over the horizon (t).
export function evalPlan(pad, draws, states, q, days) {
  return draws.map((th, d) => pad.modules.reduce((s, m, i) => s + gainT(m, th, i, states[d][i], q[i], days), 0));
}

// Value of information for one drip sample tomorrow at module j:
// linear-Gaussian update of Var(target) where target gradient is w.
export function dripValue(fit, pad, w, j, qTomorrow) {
  const P = fit.theta.length, m = pad.modules[j];
  if (!(qTomorrow > 0)) return { reduction: 0 };
  const h = 1e-5, t = pad.days; // tomorrow
  const qExt = Float64Array.from([...m.q, qTomorrow]);
  const base = moduleForward(fit.theta[2 * j], fit.theta[2 * j + 1], qExt, m.cuKg, m.stack).y[t];
  const a = new Float64Array(P);
  for (const p of [2 * j, 2 * j + 1]) {
    const aa = fit.theta[2 * j] + (p === 2 * j ? h : 0), bb = fit.theta[2 * j + 1] + (p === 2 * j + 1 ? h : 0);
    const y1 = moduleForward(aa, bb, qExt, m.cuKg, m.stack).y[t];
    a[p] = (Math.log(Math.max(y1, 1e-12)) - Math.log(Math.max(base, 1e-12))) / h;
  }
  const C = fit.cov; let Sa = new Float64Array(P);
  for (let i = 0; i < P; i++) { let s = 0; for (const p of [2 * j, 2 * j + 1]) s += C[i][p] * a[p]; Sa[i] = s; }
  const aSa = a[2 * j] * Sa[2 * j] + a[2 * j + 1] * Sa[2 * j + 1];
  let wSa = 0; for (let i = 0; i < P; i++) wSa += w[i] * Sa[i];
  const denom = aSa + SIGMA_DRIP * SIGMA_DRIP;
  return { reduction: (wSa * wSa) / denom, a, Sa, denom };
}

// Rank-one covariance update after observing a sample with sensitivity a.
export function updateCov(C, a, j) {
  const P = C.length; const Sa = new Float64Array(P);
  for (let i = 0; i < P; i++) Sa[i] = C[i][2 * j] * a[2 * j] + C[i][2 * j + 1] * a[2 * j + 1];
  const denom = a[2 * j] * Sa[2 * j] + a[2 * j + 1] * Sa[2 * j + 1] + SIGMA_DRIP * SIGMA_DRIP;
  return C.map((row, i) => row.map((x, k) => x - (Sa[i] * Sa[k]) / denom));
}

// Gradient of total remaining recoverable copper (t) wrt theta, numerically.
export function remainingGrad(theta, pad) {
  const base = ledgerFor(theta, pad); const g = new Float64Array(theta.length), h = 1e-5;
  for (let p = 0; p < theta.length; p++) { const th = theta.slice(); th[p] += h; const i = p >> 1; const m = pad.modules[i]; const f = moduleForward(th[2 * i], th[2 * i + 1], m.q, m.cuKg, m.stack); const rInf = expit(th[2 * i]); const rem = (m.cuKg * (rInf - f.R[pad.days - 1])) / 1000; g[p] = (rem - base[i].remainingT) / h; }
  return g;
}

export { expit, logit };

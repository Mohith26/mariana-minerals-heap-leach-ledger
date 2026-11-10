import { runLedger } from './core/pipeline.mjs';
import { moduleForward, expit, priorOf, QREF, quantile } from './core/leach.mjs';

const PAD = window.PAD, CAL = window.CALIB;
const R = runLedger(PAD);
const NOW = PAD.days - 1;
const START = new Date(PAD.start + 'T00:00:00Z');
const dateOf = (t) => { const d = new Date(START.getTime() + t * 864e5); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); };
const fmt = (x, d = 0) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const TYPE = { oxide: ['OXIDE', 'c-blue'], mixed: ['MIXED', 'c-purple'], sulfide: ['CHALCOCITE', 'c-orange'] };
const ROWL = 'ABCD';
const state = { sel: null, tab: 'modules', view: 'map', filter: { oxide: true, mixed: true, sulfide: true }, q: '' };
const M = PAD.modules.map((m, i) => ({ ...m, i, L: R.modules[i], qPlan: R.plan.qPlan[i], qRot: R.plan.qRot[i], pm: R.plan.perModule[i] }));
const queued = new Map(R.voi.picks.map((p, k) => [p.j, k + 1]));
const status = (m) => { const age = NOW - m.stack; if (m.q[NOW] > 0) return ['LEACHING', 'c-green']; if (age < 180) return ['REST', 'c-amber']; return ['RETIRED', 'c-gray']; };
state.sel = R.modules.slice().sort((a, b) => b.rem[1] - a.rem[1])[0].i;
const icons = () => window.lucide && window.lucide.createIcons();

// ---------- header ----------
function renderTicker() {
  const y = PAD.plsObs, last = NOW, wk = [];
  for (let t = last - 7; t < last; t++) if (y[t]) wk.push(y[t]);
  const avg = wk.reduce((a, b) => a + b, 0) / wk.length, chg = (y[last] / avg - 1) * 100;
  const flowChg = (PAD.flow[last] / PAD.flow[last - 7] - 1) * 100;
  const leaching = M.filter((m) => m.q[NOW] > 0).length;
  const drips30 = PAD.drips.filter((d) => d.t > NOW - 30).length;
  const items = [
    ['Net Cu to SX', fmt(y[last] / 1000, 2), chg, 't/d'], ['PLS flow', fmt(PAD.flow[last]), flowChg, 'm³/d'], ['Net PLS grade', fmt(y[last] / PAD.flow[last], 2), null, 'g/L'],
    ['Recoverable on pad', fmt(R.total[1]), null, 't Cu'], ['Under leach', String(leaching), null, 'modules'], ['Drip samples 30d', String(drips30), null, 'assays'],
    ['Pumping cap', fmt(R.plan.cfg.Qcap), null, 'm³/d'], ['Plan copper 14d', '+' + fmt(R.plan.uplift[1], 1), null, 't vs rotation'], ['Cu price (plan)', '$' + fmt(R.plan.cfg.cuPrice), null, '$/t'],
  ];
  const html = items.map(([n, v, c, u]) => `<span class="tk"><span class="n">${n}</span><span class="v">${v}</span>${c == null ? '' : `<span class="${c >= 0 ? 'up' : 'dn'}">${c >= 0 ? '↗' : '↘'}${c >= 0 ? '+' : ''}${c.toFixed(2)}%</span>`}<span class="u">${u}</span></span>`).join('');
  document.getElementById('ticker').innerHTML = html + html;
}
function renderCounters() {
  const anomalies = M.filter((m) => m.L.anomaly).length, leaching = M.filter((m) => m.q[NOW] > 0).length;
  const value = (R.total[1] * R.plan.cfg.cuPrice) / 1e6;
  const c = [['triangle-alert', 'var(--red)', anomalies, 'Anomaly'], ['trending-up', 'var(--orange)', fmt(R.total[1]), 't left'], ['droplets', 'var(--blue)', leaching, 'Leaching'], ['gem', '#a78bfa', '+' + fmt(R.plan.uplift[1], 1), 't plan'], ['flask-conical', 'var(--cyan)', R.voi.picks.length, 'Samples'], ['badge-dollar-sign', 'var(--orange)', '$' + fmt(value, 1) + 'M', 'In pad']];
  document.getElementById('counters').innerHTML = c.map(([ic, col, v, l]) => `<span class="ctr" style="color:${col}"><i data-lucide="${ic}"></i>${v}<span class="l">${l}</span></span>`).join('');
}

// ---------- sidebar ----------
function visible() { return M.filter((m) => state.filter[m.type] && (!state.q || (m.id + ' ' + m.type).toLowerCase().includes(state.q))); }
function moduleCard(m) {
  const [st, sc] = status(m), [tl, tc] = TYPE[m.type], age = NOW - m.stack;
  return `<div class="card ${m.i === state.sel ? 'on' : ''}" data-i="${m.i}">
    <div class="top"><span class="chip ${tc}">${tl}</span><span class="chip ${sc}">${st}</span>${m.L.anomaly ? '<span class="chip c-red">ANOMALY</span>' : ''}${queued.has(m.i) ? `<span class="chip c-cyan">SAMPLE #${queued.get(m.i)}</span>` : ''}<span class="ago"><i data-lucide="clock"></i>${age} days ago</span></div>
    <div class="h">${m.id} · ${fmt(m.L.rem[1])} t recoverable left <span style="color:#8a8a8a;font-weight:500">(${fmt(m.L.rem[0])}–${fmt(m.L.rem[2])})</span></div>
    <div class="meta"><span><i data-lucide="map-pin"></i> Pad 2, Row ${ROWL[m.row]} Cell ${m.col + 1}</span><span class="sec">${fmt(m.tonnage / 1000)} kt @ ${m.grade.toFixed(2)}% ASCu</span><a class="src" href="#"><i data-lucide="external-link"></i>Ledger</a></div>
  </div>`;
}
function renderSide() {
  const el = document.getElementById('sideList');
  if (state.tab === 'modules') el.innerHTML = visible().slice().sort((a, b) => b.L.rem[1] - a.L.rem[1]).map(moduleCard).join('');
  if (state.tab === 'samples') {
    const q = R.voi.picks.map((p, k) => `<div class="card" data-i="${p.j}"><div class="top"><span class="chip c-cyan">QUEUED #${k + 1}</span><span class="chip ${TYPE[M[p.j].type][1]}">${TYPE[M[p.j].type][0]}</span><span class="ago"><i data-lucide="clock"></i>${dateOf(NOW + 1)}</span></div><div class="h">Sample ${p.id} toe drain tomorrow</div><div class="meta"><span>Pad uncertainty ±${fmt(1.645 * p.sdBefore)} → ±${fmt(1.645 * p.sdAfter)} t</span></div></div>`).join('');
    const hist = PAD.drips.slice().reverse().slice(0, 40).map((d) => {
      const m = M[d.i]; const th = R.fit.theta; const y = moduleForward(th[2 * d.i], th[2 * d.i + 1], m.q, m.cuKg, m.stack).y[d.t]; const mc = y / m.q[d.t];
      return `<div class="card" data-i="${d.i}"><div class="top"><span class="chip c-blue">DRIP</span><span class="chip c-gray">${m.id}</span><span class="ago"><i data-lucide="clock"></i>${dateOf(d.t)}</span></div><div class="h">${m.id} toe drain: ${d.c.toFixed(2)} g/L Cu</div><div class="meta"><span>Model ${mc.toFixed(2)} g/L</span><span class="sec">residual ${((d.c / mc - 1) * 100).toFixed(0)}%</span></div></div>`;
    }).join('');
    el.innerHTML = q + hist;
  }
  if (state.tab === 'plan') el.innerHTML = M.filter((m) => Math.abs(m.qPlan - m.qRot) > 20).sort((a, b) => Math.abs(b.qPlan - b.qRot) - Math.abs(a.qPlan - a.qRot)).map((m) => {
    const up = m.qPlan > m.qRot; const re = m.qRot === 0 && m.qPlan > 0;
    return `<div class="card" data-i="${m.i}"><div class="top"><span class="chip ${up ? 'c-green' : 'c-amber'}">${re ? 'RE-IRRIGATE' : up ? 'INCREASE' : 'REDUCE'}</span><span class="chip ${TYPE[m.type][1]}">${TYPE[m.type][0]}</span><span class="ago">14-day plan</span></div><div class="h">${m.id}: ${fmt(m.qRot)} → ${fmt(m.qPlan)} m³/d</div><div class="meta"><span>Copper 14d ${fmt(m.pm.rot, 1)} → ${fmt(m.pm.plan, 1)} t</span></div></div>`;
  }).join('');
  if (state.tab === 'filters') el.innerHTML = `<div style="padding:8px 20px">${Object.keys(TYPE).map((k) => `<label style="display:flex;gap:10px;align-items:center;font-size:13px;padding:8px 0"><input type="checkbox" data-f="${k}" ${state.filter[k] ? 'checked' : ''}> <span class="chip ${TYPE[k][1]}">${TYPE[k][0]}</span> <span style="color:#969696">${M.filter((m) => m.type === k).length} modules</span></label>`).join('')}</div>`;
  el.querySelectorAll('.card').forEach((c) => c.onclick = () => { state.sel = +c.dataset.i; if (state.view !== 'map') setView('map'); else { renderView(); } renderSide(); });
  el.querySelectorAll('input[data-f]').forEach((c) => c.onchange = () => { state.filter[c.dataset.f] = c.checked; renderView(); });
  icons();
}

// ---------- charts ----------
const lerp = (a, b, t) => a + (b - a) * t;
function blueScale(v) { const t = Math.min(1, Math.max(0, v)); const c0 = [17, 24, 39], c1 = [4, 118, 174], c2 = [56, 189, 248]; const [a, b, u] = t < 0.6 ? [c0, c1, t / 0.6] : [c1, c2, (t - 0.6) / 0.4]; return `rgb(${a.map((x, k) => Math.round(lerp(x, b[k], u))).join(',')})`; }

function padMap() {
  const W = 640, H = 545, cw = 92, ch = 100, gx = 8, gy = 10, ox = (W - (6 * cw + 5 * gx)) / 2, oy = 40;
  const max = Math.max(...M.map((m) => m.L.rem[1]));
  let g = `<defs><pattern id="drip" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="#38bdf8" fill-opacity=".55"/></pattern></defs>`;
  // contour backdrop
  for (let k = 0; k < 9; k++) g += `<ellipse cx="${W / 2}" cy="${H / 2 + 10}" rx="${120 + k * 38}" ry="${80 + k * 26}" fill="none" stroke="#ffffff" stroke-opacity="0.035"/>`;
  g += `<rect x="${ox - 14}" y="${oy - 14}" width="${6 * cw + 5 * gx + 28}" height="${4 * ch + 3 * gy + 28}" rx="10" fill="#101216" stroke="#262626"/>`;
  g += `<text x="${ox - 14}" y="${oy - 24}" style="font-size:11px;fill:#a3a3a3;font-weight:600">PAD 2 · PLAN VIEW · ROWS A–D WEST → EAST</text>`;
  M.forEach((m) => {
    const x = ox + m.col * (cw + gx), y = oy + m.row * (ch + gy), rem = m.L.rem[1];
    const sel = m.i === state.sel, irr = m.q[NOW] > 0;
    g += `<g class="mod" data-i="${m.i}" style="cursor:pointer"><rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="5" fill="${blueScale(rem / max)}" stroke="${sel ? '#ffffff' : m.L.anomaly ? '#ef4444' : '#2a2f3a'}" stroke-width="${sel ? 2 : m.L.anomaly ? 1.5 : 1}"/>`;
    if (irr) g += `<rect x="${x + 1}" y="${y + 1}" width="${cw - 2}" height="${ch - 2}" rx="5" fill="url(#drip)"/>`;
    const bright = rem / max > 0.72, c1 = bright ? '#03131d' : '#ffffff', c2 = bright ? '#0b2a3b' : '#cbd5e1', c3 = bright ? '#0b2a3b' : '#94a3b8';
    g += `<text x="${x + 8}" y="${y + 16}" style="font-size:10.5px;font-weight:700;fill:${bright ? '#03131d' : '#e5e5e5'}">${m.id}</text>`;
    g += `<text x="${x + 8}" y="${y + 50}" style="font-size:19px;font-weight:700;fill:${c1}">${fmt(rem)}<tspan style="font-size:10px;fill:${c2};font-weight:500"> t</tspan></text>`;
    g += `<text x="${x + 8}" y="${y + 66}" style="font-size:9.5px;fill:${c2}">${fmt(m.L.rem[0])}–${fmt(m.L.rem[2])} t</text>`;
    g += `<text x="${x + 8}" y="${y + ch - 10}" style="font-size:9.5px;fill:${c3}">${Math.round(100 * m.L.recovered)}% recovered</text>`;
    if (queued.has(m.i)) g += `<circle cx="${x + cw - 14}" cy="${y + 14}" r="9" fill="#06b6d4"/><text x="${x + cw - 14}" y="${y + 17.5}" text-anchor="middle" style="font-size:10px;font-weight:700;fill:#041016">${queued.get(m.i)}</text>`;
    if (m.L.anomaly) { const ax = x + cw - (queued.has(m.i) ? 38 : 21), ay = y + 21; g += `<path d="M${ax} ${ay} l7 -13 l7 13 z" fill="#ef4444"/><text x="${ax + 7}" y="${ay - 2}" text-anchor="middle" style="font-size:8.5px;font-weight:800;fill:#140404">!</text>`; }
    g += `</g>`;
  });
  // legend
  const ly = H - 34;
  for (let k = 0; k < 10; k++) g += `<rect x="${ox + k * 18}" y="${ly}" width="18" height="8" fill="${blueScale(k / 9)}"/>`;
  g += `<text x="${ox}" y="${ly - 6}">RECOVERABLE Cu LEFT (POSTERIOR MEDIAN)</text><text x="${ox}" y="${ly + 20}">0 t</text><text x="${ox + 180}" y="${ly + 20}" text-anchor="end">${fmt(max)} t</text>`;
  g += `<rect x="${ox + 220}" y="${ly}" width="12" height="8" fill="url(#drip)" stroke="#38bdf8" stroke-opacity=".4"/><text x="${ox + 238}" y="${ly + 7}">IRRIGATED TODAY</text>`;
  g += `<circle cx="${ox + 352}" cy="${ly + 4}" r="5" fill="#06b6d4"/><text x="${ox + 362}" y="${ly + 7}">NEXT DRIP SAMPLE</text>`;
  g += `<path d="M${ox + 474} ${ly + 9} l5 -9 l5 9 z" fill="#ef4444"/><text x="${ox + 488}" y="${ly + 7}">OFF COLUMN-TEST PRIOR</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" id="padsvg">${g}</svg>`;
}

function recoveryCurve(m) {
  const W = 330, H = 150, l = 30, r = 8, t = 10, b = 22;
  const days = Math.max(60, NOW - m.stack + 30), T0 = m.stack;
  const qExt = m.q.concat(Array(30).fill(m.qPlan));
  const curves = R.drawsSample.map((th) => moduleForward(th[2 * m.i], th[2 * m.i + 1], qExt, m.cuKg, m.stack).R);
  const pr = priorOf(m.type), prior = moduleForward(pr.ma, pr.mb, qExt, m.cuKg, m.stack).R;
  const x = (d) => l + (d / days) * (W - l - r), y = (v) => H - b - v * (H - b - t);
  let g = '';
  for (const v of [0, 0.25, 0.5, 0.75, 1]) g += `<line x1="${l}" x2="${W - r}" y1="${y(v)}" y2="${y(v)}" stroke="#262626"/><text x="${l - 6}" y="${y(v) + 3}" text-anchor="end">${v * 100}%</text>`;
  let up = '', lo = '', med = '';
  for (let d = 0; d <= days; d += 2) { const tt = T0 + d; if (tt >= qExt.length) break; const col = curves.map((c) => c[tt]); up += `${x(d)},${y(quantile(col, 0.95))} `; lo = `${x(d)},${y(quantile(col, 0.05))} ` + lo; med += `${x(d)},${y(quantile(col, 0.5))} `; }
  g += `<polygon points="${up}${lo}" fill="#0476ae" fill-opacity=".35"/><polyline points="${med}" fill="none" stroke="#38bdf8" stroke-width="1.6"/>`;
  let pp = ''; for (let d = 0; d <= days; d += 2) { const tt = T0 + d; if (tt >= qExt.length) break; pp += `${x(d)},${y(prior[tt])} `; }
  g += `<polyline points="${pp}" fill="none" stroke="#a3a3a3" stroke-dasharray="3 3"/>`;
  const dn = NOW - T0; g += `<line x1="${x(dn)}" x2="${x(dn)}" y1="${t}" y2="${H - b}" stroke="#f97316"/><text x="${x(dn) - 4}" y="${t + 8}" text-anchor="end" style="fill:#f97316">TODAY</text>`;
  g += `<text x="${l}" y="${H - 6}">STACKED ${dateOf(T0).toUpperCase()}</text><text x="${W - r}" y="${H - 6}" text-anchor="end">+${days} D</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${g}</svg><div class="legend" style="padding:4px 14px 0"><span><span class="sw" style="background:#38bdf8"></span>Posterior, 90%</span><span><span class="sw" style="background:#a3a3a3"></span>Column-test prior</span><span>+30 d at plan rate</span></div>`;
}

function stacked(days0, W, H, opts = {}) {
  const l = 40, r = 10, t = 12, b = 24, n = PAD.days;
  const ts = []; for (let k = days0; k < n; k++) ts.push(k);
  const tot = ts.map((k) => R.contrib.reduce((s, c) => s + c[k], 0));
  const ymax = Math.max(...ts.map((k, j) => Math.max(tot[j], (PAD.plsObs[k] || 0) / 1000, R.band[k][1]))) * 1.1;
  const x = (k) => l + ((k - days0) / (n - 1 - days0)) * (W - l - r), y = (v) => H - b - (v / ymax) * (H - b - t);
  let g = '';
  for (let v = 0; v <= ymax; v += ymax > 30 ? 10 : 5) g += `<line x1="${l}" x2="${W - r}" y1="${y(v)}" y2="${y(v)}" stroke="#1f1f23"/><text x="${l - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
  const base = ts.map(() => 0);
  const shade = { oxide: [59, 130, 246], mixed: [139, 92, 246], sulfide: [249, 115, 22] };
  M.forEach((m, i) => {
    const c = R.contrib[i]; let top = '', bot = '';
    ts.forEach((k, j) => { top += `${x(k).toFixed(1)},${y(base[j] + c[k]).toFixed(1)} `; });
    for (let j = ts.length - 1; j >= 0; j--) bot += `${x(ts[j]).toFixed(1)},${y(base[j]).toFixed(1)} `;
    ts.forEach((k, j) => { base[j] += c[k]; });
    const [rr, gg, bb] = shade[m.type], f = 0.45 + 0.5 * ((i % 4) / 3);
    const sel = i === state.sel;
    g += `<polygon points="${top}${bot}" fill="rgb(${Math.round(rr * f)},${Math.round(gg * f)},${Math.round(bb * f)})" ${sel ? 'stroke="#fff" stroke-width="1"' : 'stroke="#09090b" stroke-width=".3"'}/>`;
  });
  let bu = '', bl = ''; ts.forEach((k) => { bu += `${x(k)},${y(R.band[k][1])} `; }); for (let j = ts.length - 1; j >= 0; j--) bl += `${x(ts[j])},${y(R.band[ts[j]][0])} `;
  g += `<polygon points="${bu}${bl}" fill="none" stroke="#e5e5e5" stroke-opacity=".5" stroke-dasharray="2 2"/>`;
  ts.forEach((k) => { if (PAD.plsObs[k]) g += `<circle cx="${x(k)}" cy="${y(PAD.plsObs[k] / 1000)}" r="${opts.big ? 1.6 : 1.3}" fill="#fff"/>`; });
  const step = opts.big ? 30 : 30;
  for (let k = days0; k < n; k += step) g += `<text x="${x(k)}" y="${H - 6}" text-anchor="middle">${dateOf(k)}</text>`;
  g += `<text x="${l}" y="${t - 2}" style="fill:#a3a3a3">t Cu/day</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${g}</svg>`;
}

// ---------- views ----------
function detailPanel(m) {
  const L = m.L, [st, sc] = status(m), [tl, tc] = TYPE[m.type], pr = priorOf(m.type);
  const tr = PAD.truthNow[m.i], trem = (m.cuKg * (tr.rInf - tr.R)) / 1000;
  return `<div class="panel">
    <div class="ph"><span class="t">${m.id} · Row ${ROWL[m.row]} Cell ${m.col + 1}</span><span><span class="chip ${tc}">${tl}</span> <span class="chip ${sc}">${st}</span></span></div>
    <div class="kv">
      <div><div class="l">Recoverable left</div><div class="v">${fmt(L.rem[1])} t<small>${fmt(L.rem[0])}–${fmt(L.rem[2])}</small></div></div>
      <div><div class="l">Recovered to date</div><div class="v">${Math.round(100 * L.recovered)}%<small>of ${fmt(m.cuKg / 1000)} t contained</small></div></div>
      <div><div class="l">Ultimate recovery</div><div class="v">${Math.round(100 * L.rInf[1])}%<small>prior ${Math.round(100 * expit(pr.ma))}%</small></div></div>
      <div><div class="l">Leach rate k</div><div class="v">${L.k[1].toFixed(3)}<small>/d · prior ${Math.exp(pr.mb).toFixed(3)}</small></div></div>
    </div>
    ${recoveryCurve(m)}
    <div class="note" style="padding-top:10px">${L.anomaly ? `<b style="color:#ef4444">Off prior:</b> ${L.anomaly}. ` : ''}${L.nDrips} drip assay${L.nDrips === 1 ? '' : 's'} on this module; the rest of its ledger comes from the combined PLS stream. Plan: ${fmt(m.qRot)} → <b>${fmt(m.qPlan)} m³/d</b> for 14 days (${fmt(m.pm.plan, 1)} t expected). <span style="color:#5d5d5d">Synthetic truth: ${fmt(trem)} t left.</span></div>
  </div>`;
}

function viewMap() {
  const m = M[state.sel];
  const sd0 = R.voi.sdTotal * 1.645, last = R.voi.picks[R.voi.picks.length - 1];
  const pairNote = R.worstPair ? `${R.worstPair.a} and ${R.worstPair.b} are the least separable pair (posterior correlation ${R.worstPair.c.toFixed(2)}).` : '';
  return `<div style="display:grid;grid-template-columns:1fr 352px;gap:16px;margin-top:34px">
      <div>${padMap()}</div>
      <div>${detailPanel(m)}</div>
    </div>
    <div class="bottom">
      <div class="panel"><div class="ph"><span class="t">Combined PLS, attributed to modules</span><button class="btn" data-go="attr">Open<i data-lucide="arrow-up-right"></i></button></div>${stacked(PAD.days - 120, 460, 150)}<div class="note">Dots: measured net Cu to SX. Bands: each module's inferred share. One stream, ${PAD.modules.length} sources.</div></div>
      <div class="panel"><div class="ph"><span class="t">Next drip samples</span><span class="s">value of information</span></div>
        <table class="tb"><tbody>${R.voi.picks.map((p, k) => `<tr><td><span class="chip c-cyan">#${k + 1}</span></td><td>${p.id}</td><td class="num">±${fmt(1.645 * p.sdBefore)} → ±${fmt(1.645 * p.sdAfter)} t</td></tr>`).join('')}</tbody></table>
        <div class="note" style="padding-top:10px">Three assays tomorrow cut the 90% range on pad copper from ±${fmt(sd0)} to ±${fmt(1.645 * last.sdAfter)} t. ${pairNote}</div></div>
      <div class="panel"><div class="ph"><span class="t">14-day irrigation plan</span><button class="btn" data-go="plan">Open<i data-lucide="arrow-up-right"></i></button></div>
        <div style="padding:10px 14px 0"><div class="big">+${fmt(R.plan.uplift[1], 1)} t<small>${fmt(R.plan.uplift[0], 1)} to ${fmt(R.plan.uplift[2], 1)}</small></div></div>
        <div class="note" style="padding-top:6px">More copper than the current rotation from the same ${fmt(R.plan.cfg.Qcap)} m³/d of raffinate, ≈ $${fmt((R.plan.uplift[1] * R.plan.cfg.cuPrice) / 1000)}k at $${fmt(R.plan.cfg.cuPrice)}/t. Better in ${Math.round(100 * R.plan.pBetter)}% of posterior draws.</div></div>
    </div>`;
}

function viewAttr() {
  const rows = M.slice().sort((a, b) => a.stack - b.stack).map((m) => `<tr data-i="${m.i}" style="cursor:pointer"><td>${m.id}</td><td><span class="chip ${TYPE[m.type][1]}">${TYPE[m.type][0]}</span></td><td class="num">${dateOf(m.stack)}</td><td class="num">${fmt(m.L.drainedT)}</td><td class="num">${Math.round(100 * m.L.recovered)}%</td><td class="num">${fmt(m.L.rem[1])} (${fmt(m.L.rem[0])}–${fmt(m.L.rem[2])})</td><td class="num">${m.L.nDrips}</td></tr>`).join('');
  return `<div style="margin-top:34px" class="panel"><div class="ph"><span class="t">Net copper to SX: measured vs inferred module contributions</span><span class="s">${PAD.plsDays.length} daily PLS readings · ${PAD.drips.length} drip assays · fit: ${R.fit.iters} Levenberg-Marquardt steps, then ${fmt(R.mcmc.sweeps)} Gibbs sweeps (acceptance ${Math.round(100 * R.mcmc.acceptance)}%)</span></div>${stacked(0, 1000, 320, { big: true })}
    <div class="legend" style="padding:0 14px 12px"><span><span class="sw" style="background:#3b82f6"></span>Oxide modules</span><span><span class="sw" style="background:#8b5cf6"></span>Mixed</span><span><span class="sw" style="background:#f97316"></span>Chalcocite</span><span><span class="sw" style="background:#fff;border-radius:50%"></span>Measured net Cu (PLS flow × grade − raffinate)</span><span>Dashed: 90% posterior predictive</span></div></div>
    <div class="panel" style="margin-top:12px"><table class="tb"><thead><tr><th>Module</th><th>Ore</th><th>Stacked</th><th>Drained to date (t)</th><th>Recovered</th><th>Recoverable left (t, 90%)</th><th>Drip assays</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function viewPlan() {
  const rows = M.filter((m) => m.qPlan > 1 || m.qRot > 1).sort((a, b) => b.qPlan - a.qPlan).map((m) => `<tr data-i="${m.i}" style="cursor:pointer"><td>${m.id}</td><td><span class="chip ${status(m)[1]}">${status(m)[0]}</span></td><td class="num">${fmt(m.qRot)}</td><td style="width:110px"><div class="bar"><span style="width:${(100 * m.qRot) / (1.6 * QREF)}%;background:#52525b"></span></div></td><td class="num">${fmt(m.qPlan)}</td><td style="width:110px"><div class="bar"><span style="width:${(100 * m.qPlan) / (1.6 * QREF)}%;background:#38bdf8"></span></div></td><td class="num">${fmt(m.pm.rot, 1)}</td><td class="num">${fmt(m.pm.plan, 1)}</td><td class="num" style="color:${m.pm.plan >= m.pm.rot ? '#22c55e' : '#f97316'}">${m.pm.plan >= m.pm.rot ? '+' : ''}${fmt(m.pm.plan - m.pm.rot, 1)}</td></tr>`).join('');
  const c = CAL.withAnomalies, c0 = CAL.noAnomalies;
  return `<div style="margin-top:34px" class="panel"><div class="ph"><span class="t">Raffinate allocation, next ${R.plan.cfg.days} days</span><span class="s">maximizes posterior-expected copper − $${R.plan.cfg.costPerM3}/m³ pumping and acid, ${fmt(R.plan.cfg.Qcap)} m³/d cap, ≤ ${fmt(1.6 * QREF)} m³/d per module</span></div>
    <table class="tb" style="margin-top:8px"><thead><tr><th>Module</th><th>Status</th><th>Rotation m³/d</th><th></th><th>Plan m³/d</th><th></th><th>Rotation Cu (t)</th><th>Plan Cu (t)</th><th>Δ</th></tr></thead><tbody>${rows}
    <tr><td><b>Pad</b></td><td></td><td class="num">${fmt(R.plan.waterRot)}</td><td></td><td class="num">${fmt(R.plan.waterPlan)}</td><td></td><td class="num">${fmt(R.plan.gainRot[1], 1)}</td><td class="num">${fmt(R.plan.gainPlan[1], 1)}</td><td class="num" style="color:#22c55e">+${fmt(R.plan.uplift[1], 1)}</td></tr></tbody></table>
    <div class="note" style="padding-top:12px">Copper totals are posterior medians of copper dissolved over the horizon; the pad uplift interval (${fmt(R.plan.uplift[0], 1)} to ${fmt(R.plan.uplift[2], 1)} t) is computed draw by draw, so it accounts for shared uncertainty. Retired modules with copper still in them are eligible; the rotation never revisits them.</div></div>
    <div class="panel" style="margin-top:12px"><div class="ph"><span class="t">Are the intervals honest?</span><span class="s">${c.pads} synthetic pads, full refit each</span></div>
    <div class="kv" style="grid-template-columns:repeat(3,1fr)"><div><div class="l">Module copper left, 90% CI</div><div class="v">${Math.round(100 * c.moduleCoverage90)}%<small>covered truth (${fmt(c.moduleIntervals)} intervals)</small></div></div><div><div class="l">Pad total, 90% CI</div><div class="v">${Math.round(100 * c.padTotalCoverage90)}%<small>covered truth</small></div></div><div><div class="l">14-day gain, 90% CI</div><div class="v">${Math.round(100 * c.gainCoverage90)}%<small>covered truth</small></div></div></div>
    <div class="note">Slightly overconfident: 2 to 4 points under nominal. Without the two planted off-prior modules per pad: ${Math.round(100 * c0.moduleCoverage90)}%, ${Math.round(100 * c0.padTotalCoverage90)}%, ${Math.round(100 * c0.gainCoverage90)}%.</div></div>`;
}

function renderView() {
  const v = document.getElementById('view');
  v.innerHTML = state.view === 'map' ? viewMap() : state.view === 'attr' ? viewAttr() : viewPlan();
  v.querySelectorAll('.mod, tr[data-i]').forEach((g) => g.onclick = () => { state.sel = +g.dataset.i; setView('map'); renderSide(); });
  v.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => setView(b.dataset.go));
  icons();
}
function setView(v) { state.view = v; document.querySelectorAll('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); renderView(); }

document.querySelectorAll('#seg button').forEach((b) => b.onclick = () => setView(b.dataset.v));
document.querySelectorAll('#sideTabs button').forEach((b) => b.onclick = () => { state.tab = b.dataset.t; document.querySelectorAll('#sideTabs button').forEach((x) => x.classList.toggle('on', x === b)); renderSide(); });
document.getElementById('q').oninput = (e) => { state.q = e.target.value.toLowerCase(); renderSide(); };
if (['#attr', '#plan'].includes(location.hash)) state.view = location.hash.slice(1);
document.querySelectorAll('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.view));
renderTicker(); renderCounters(); renderSide(); renderView(); icons();

// Batch run: writes data/results.json (the page recomputes the same thing live).
import { readFileSync, writeFileSync } from 'node:fs';
import { runLedger } from '../core/pipeline.mjs';
const pad = JSON.parse(readFileSync(new URL('../data/pad.json', import.meta.url)));
const res = runLedger(pad);
writeFileSync(new URL('../data/results.json', import.meta.url), JSON.stringify(res));
console.log('ms', res.ms, 'total', res.total.map((x) => x.toFixed(0)).join(' / '), 'uplift', res.plan.uplift.map((x) => x.toFixed(1)).join(' / '), 'pBetter', res.plan.pBetter);

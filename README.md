# Heap Leach Ledger: where the copper is on a leach pad, from one PLS stream

**Live demo:** https://mohith26.github.io/mariana-minerals-heap-leach-ledger/

Unofficial concept demo by Mohith Gajjela. Not affiliated with Mariana Minerals. All data is synthetic.

## What it is

At a heap-leach operation like Copper One, every module on the pad drains into the same PLS ditch. The plant measures one combined stream (flow and grade into SX), plus a few toe-drain assays a week. So the question that drives irrigation, sampling and retirement decisions, *how much recoverable copper is left in each module*, is not measured directly. It has to be inferred.

The Heap Leach Ledger is a PlantOS page that:

1. **Attributes the combined PLS stream back to the 24 modules.** Each module follows a first-order leach curve (ultimate recovery and rate, rate scaled by irrigation intensity), dissolved copper reaches the PLS through a travel-time kernel, and the sum must match the daily net copper transfer to SX. Priors come from column tests by ore type (oxide, mixed, chalcocite).
2. **Gives calibrated uncertainty, not a point estimate.** Levenberg-Marquardt for the MAP, then a block Metropolis-within-Gibbs sampler (one block per module, proposals shaped by the Laplace covariance) for exact posterior draws. Every number on the page is a posterior median with a 90% interval.
3. **Flags modules that disagree with their column tests** (here M-09, whose block-model grade is planted as overstated, and M-15, planted with channeling-slow kinetics).
4. **Says which drip samples to take tomorrow.** Value of information: the expected reduction in the variance of total recoverable copper from one assay at each irrigated module, using the linearized posterior, chosen greedily with rank-one updates. Modules that the combined stream cannot separate (correlated posteriors) are where a single assay helps most.
5. **Re-allocates raffinate for the next 14 days.** Maximizes posterior-expected copper minus pumping and acid cost under the pump cap, with per-module limits. The objective is separable and concave, so it is solved exactly by bisection on the Lagrange multiplier with golden-section search per module. Retired modules that still hold copper are eligible.

On the synthetic pad (seed 20261109): about **1,108 t** recoverable copper left (90%: 982 to 1,235 t); the plan dissolves **+12.9 t** more than the current rotation over 14 days (90%: 10.6 to 15.5 t) with the same 8,100 m³/d, better in 100% of posterior draws, largely by putting more raffinate on the fresh chalcocite modules and re-irrigating M-11, which the rotation retired with about 42 t still in it. The first recommended drip sample is M-11, which has never been assayed.

## How honest are the intervals?

`scripts/calibrate.mjs` regenerates 100 synthetic pads with different seeds and refits each from scratch. 90% intervals covered the truth 86% of the time for module copper left (2,400 intervals), 88% for the pad total and 86% for the 14-day gain. Without the two planted off-prior modules per pad: 88%, 88%, 87%. So the ledger is slightly overconfident (2 to 4 points), and the page says so. The Laplace approximation alone was worse (77% for the pad total), which is why the sampler exists; a Laplace plus importance-resampling variant collapsed (effective sample size about 10 in 48 dimensions) and was dropped.

## Files

- `core/leach.mjs`: forward model, LM fit, Laplace covariance, block MwG sampler, ledger, allocation, value of information.
- `core/pipeline.mjs`: the end-to-end run used by the page, the batch script and the tests.
- `scripts/gen_pad.mjs`: seeded synthetic pad (24 modules, 330 days, rotation irrigation, daily PLS, about 1.5 drip assays a week, two planted anomalies).
- `scripts/run.mjs`, `scripts/calibrate.mjs`: batch result and calibration study.
- `index.html`, `app.js`, `styles.css`: static page. It recomputes the whole ledger in the browser on load (about 0.6 s).

## Tests

```
node --test tests/leach.test.mjs
```

9 tests: kernel normalization; copper conservation and saturation in the forward model; linear algebra; recovery of per-module copper from the combined stream; MCMC acceptance and location; allocation respects the cap, beats rotation in expectation and matches brute force on a 2-module toy; value of information equals an explicit rank-one posterior update; committed results reproduce; the planted anomalies are exactly the flagged modules.

## Honest limitations

- One-dimensional first-order kinetics per module. Real heaps have multi-lift solution flow, acid and ferric limits, bacterial activity, temperature, aeration and preferential flow; Mariana's PlantOS world model is surely richer. The point is the estimation layer on top of whatever model is used.
- The data generator and the inference model share the model family (apart from the planted anomalies), so this shows the method working when the model is roughly right.
- "Ultimate recovery" is relative to block-model grade, so a grade bias shows up as low recovery (M-09).
- The 14-day gain counts copper dissolved; with a 4-day mean travel time most of it reaches SX within the window.
- Raffinate grade, acid consumption per module and SX capacity are folded into a flat $/m³ cost and a pump cap.
- Module names, tonnages, grades, schedule and prices are invented.

## Novelty note

Mariana's public material describes PlantOS world models from kinetic fitting and RL control across seven unit operations including heap bioleaching; nothing public describes a per-module copper ledger with calibrated uncertainty or a sampling planner. Adjacent prior art exists and is acknowledged: IntelliSense.io sells a heap-leach optimization app (virtual sensors, irrigation guidance), a Freeport-McMoRan patent covers leach-pad digital twins and ore mapping from PLS and irrigation data, and academic work optimizes irrigation plans (e.g. Minerals Engineering 2025, Copper 2022). The combination here (combined-stream attribution with exact posterior sampling, an explicit calibration study, value-of-information drip sampling and a posterior-expected allocation) is what I could not find.

Design: the app shell follows Mariana's production Critical Minerals Monitor (marianaminerals.com/monitor): its dark shadcn theme, Open Sans, Lucide icons, feed-style sidebar, segmented view control and header counters. The Mariana Minerals logo is used only because the demo is addressed to Mariana.

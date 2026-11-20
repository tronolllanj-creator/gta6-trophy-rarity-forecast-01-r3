import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

// Top-trophy refresh model: at each Exophase refresh, the cohort earn increment
// concentrates entirely on the few trophies with highest earned counts.
// Other trophies' earned counts stay flat, so their rates drop as N grows.
// We estimate per-trophy cohort earn rates s_i from refresh history,
// extrapolate N to target, project earned counts, and build logit-normal
// prediction intervals with sigma calibrated by backtest.

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function logit(p: number): number {
  p = clamp(p, 0.01, 99.99);
  return Math.log(p / (100 - p));
}

function invLogit(l: number): number {
  const p = 100 / (1 + Math.exp(-l));
  return clamp(p, 0.01, 99.99);
}

function hoursSinceRef(at: string): number {
  const ref = Date.parse('2026-11-19T00:00:00Z');
  const t = Date.parse(at);
  return (t - ref) / 3_600_000;
}

function leastSquares(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, b, i) => a + b * ys[i], 0);
  const sumXX = xs.reduce((a, b) => a + b * b, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function main() {
  const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const files = readdirSync(inputDir).filter(f => f.endsWith('.in')).sort();
  if (files.length === 0) throw new Error('No .in file found');
  for (const file of files) {
    processOneFile(inputDir, outputDir, file);
  }
}

function processOneFile(inputDir: string, outputDir: string, file: string) {
  const inputPath = join(inputDir, file);
  const caseId = basename(file, '.in');
  const outputPath = join(outputDir, `${caseId}.out`);

  const raw = readFileSync(inputPath, 'utf-8');
  const kase = JSON.parse(raw);

  const trophies = kase.trophies;
  const history = kase.history;
  const horizonMinutes = kase.horizon_minutes;
  const targetAt = new Date(Date.parse(kase.at) + horizonMinutes * 60_000).toISOString();

  // Step 1: Earned counts per read, collapse duplicate states
  const states: Array<{ at: string; N: number; rates: number[]; earned: number[] }> = [];
  for (const h of history) {
    const N = h.players_tracked;
    const rates = h.rates.map((r: number | null) => r ?? 0);
    const earned = rates.map((r, i) => (r / 100) * N);
    const last = states[states.length - 1];
    if (last && last.N === N && last.rates.every((v, i) => v === rates[i])) {
      continue;
    }
    states.push({ at: h.at, N, rates, earned });
  }

  // Step 2: Identify refreshes (N increases > 1.001x)
  const refreshes: Array<{ before: typeof states[0]; after: typeof states[0] }> = [];
  for (let i = 1; i < states.length; i++) {
    if (states[i].N > states[i - 1].N * 1.001) {
      refreshes.push({ before: states[i - 1], after: states[i] });
    }
  }

  const T = trophies.length;
  const lastState = states[states.length - 1];
  const N_last = lastState.N;
  const E_last = lastState.earned;
  const rate_last = lastState.rates;

  // Handle null rates in last read: use last non-null
  const finalRates: number[] = [];
  const finalEarned: number[] = [];
  const finalN: number[] = [];
  for (let i = 0; i < T; i++) {
    if (lastState.rates[i] !== null && lastState.rates[i] !== undefined) {
      finalRates[i] = lastState.rates[i];
      finalEarned[i] = lastState.earned[i];
      finalN[i] = lastState.N;
    } else {
      // find last non-null
      let found = false;
      for (let s = states.length - 2; s >= 0; s--) {
        if (states[s].rates[i] !== null && states[s].rates[i] !== undefined) {
          finalRates[i] = states[s].rates[i];
          finalEarned[i] = states[s].earned[i];
          finalN[i] = states[s].N;
          found = true;
          break;
        }
      }
      if (!found) {
        finalRates[i] = 0;
        finalEarned[i] = 0;
        finalN[i] = lastState.N;
      }
    }
  }

  // Step 3: Cohort earn rates per refresh
  let s_i: number[] = new Array(T).fill(0);
  let hasRefreshes = refreshes.length > 0;

  if (hasRefreshes) {
    const s_per_refresh: number[][] = [];
    for (const ref of refreshes) {
      const dN = ref.after.N - ref.before.N;
      const s: number[] = [];
      for (let i = 0; i < T; i++) {
        const dE = ref.after.earned[i] - ref.before.earned[i];
        const val = dN > 0 ? clamp((dE / dN) * 100, 0, 100) : 0;
        s.push(val);
      }
      s_per_refresh.push(s);
    }
    // Recency-weighted mean: weight 2^k, most recent highest
    const weights = s_per_refresh.map((_, k) => Math.pow(2, k));
    const sumW = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < T; i++) {
      let num = 0;
      for (let k = 0; k < s_per_refresh.length; k++) {
        num += s_per_refresh[k][i] * weights[k];
      }
      s_i[i] = num / sumW;
    }
  }

  // Step 4: N(target)
  let N_target: number;
  const distinctN = states.map(s => s.N);
  const distinctHours = states.map(s => hoursSinceRef(s.at));
  
  if (distinctN.length >= 2) {
    const logN = distinctN.map(n => Math.log(n));
    const logH = distinctHours.map(h => Math.log(1 + h));
    const fit = leastSquares(logH, logN);
    const targetHours = hoursSinceRef(targetAt);
    const logN_pred = fit.slope * Math.log(1 + targetHours) + fit.intercept;
    N_target = Math.exp(logN_pred);
    N_target = clamp(N_target, N_last, 50 * N_last);
  } else {
    // Flat-history fallback will be used in step 6
    N_target = N_last * 6.06;
  }

  // Step 5 & 6: E_i(target) and medians
  const E_target: number[] = new Array(T);
  const medians: number[] = new Array(T);
  const pinned: boolean[] = new Array(T).fill(false);
  const topTrophyIndices: number[] = [];

  if (!hasRefreshes) {
    // Flat-history fallback
    const total_earned_last = finalEarned.reduce((a, b) => a + b, 0);
    const total_earned_target = total_earned_last * (4276 / 943);
    const dN = N_target - N_last;

    // Pinned trophies (rate >= 99.99)
    for (let i = 0; i < T; i++) {
      if (finalRates[i] >= 99.99) {
        pinned[i] = true;
        E_target[i] = finalEarned[i] + dN;
      }
    }
    const n_pinned = pinned.filter(p => p).length;

    // Remainder distribution
    let remainder = total_earned_target - total_earned_last - n_pinned * dN;
    if (remainder < 0) remainder = 0;

    // Top trophies: the 4 with the largest earned counts E_i (excluding pinned).
    // Rank-based, not a threshold: rates are rounded to 2 decimals, so a 1.25%
    // trophy has E = 7.98, just below an E >= 8 cutoff.
    const others = Array.from({ length: T }, (_, i) => i).filter(i => !pinned[i]);
    others.sort((a, b) => finalEarned[b] - finalEarned[a]);
    topTrophyIndices.push(...others.slice(0, 4));

    const share = topTrophyIndices.length > 0 ? remainder / topTrophyIndices.length : 0;
    for (let i = 0; i < T; i++) {
      if (pinned[i]) continue;
      if (topTrophyIndices.includes(i)) {
        E_target[i] = finalEarned[i] + share;
      } else {
        E_target[i] = finalEarned[i];
      }
    }
  } else {
    // Has refreshes
    for (let i = 0; i < T; i++) {
      if (finalRates[i] >= 99.99) {
        pinned[i] = true;
        E_target[i] = finalEarned[i] + (N_target - N_last);
      } else {
        E_target[i] = finalEarned[i] + s_i[i] / 100 * Math.max(0, N_target - N_last);
      }
    }
  }

  for (let i = 0; i < T; i++) {
    if (pinned[i]) {
      medians[i] = 99.99;
    } else {
      medians[i] = clamp(100 * E_target[i] / N_target, 0.01, 99.99);
    }
  }

  // Step 7: Sigma per trophy
  const sigmas: number[] = new Array(T);

  if (!hasRefreshes) {
    for (let i = 0; i < T; i++) {
      if (pinned[i]) {
        sigmas[i] = 0.05;
      } else if (topTrophyIndices.includes(i)) {
        sigmas[i] = 0.45;
      } else {
        sigmas[i] = 0.10;
      }
    }
  } else {
    // Backtest each refresh after the first
    const backtestErrors: number[][] = []; // per trophy
    for (let i = 0; i < T; i++) backtestErrors[i] = [];

    for (let r = 1; r < refreshes.length; r++) {
      // Estimate s_i from refreshes 0..r-1
      const s_est: number[] = new Array(T).fill(0);
      const weights = Array.from({ length: r }, (_, k) => Math.pow(2, k));
      const sumW = weights.reduce((a, b) => a + b, 0);
      for (let i = 0; i < T; i++) {
        let num = 0;
        for (let k = 0; k < r; k++) {
          const ref = refreshes[k];
          const dN = ref.after.N - ref.before.N;
          const dE = ref.after.earned[i] - ref.before.earned[i];
          const val = dN > 0 ? clamp((dE / dN) * 100, 0, 100) : 0;
          num += val * weights[k];
        }
        s_est[i] = num / sumW;
      }
      // Predict post-refresh rates for refresh r
      const ref = refreshes[r];
      const dN = ref.after.N - ref.before.N;
      for (let i = 0; i < T; i++) {
        const E_pred = ref.before.earned[i] + s_est[i] / 100 * dN;
        const rate_pred = clamp(100 * E_pred / ref.after.N, 0.01, 99.99);
        const rate_true = clamp(ref.after.rates[i], 0.01, 99.99);
        const err = logit(rate_pred) - logit(rate_true);
        backtestErrors[i].push(err);
      }
    }

    const sigma_backtest: number[] = new Array(T);
    for (let i = 0; i < T; i++) {
      if (backtestErrors[i].length === 0) {
        sigma_backtest[i] = 0.6;
      } else {
        const sq = backtestErrors[i].reduce((a, e) => a + e * e, 0);
        sigma_backtest[i] = Math.sqrt(sq / backtestErrors[i].length);
      }
    }

    const lnRatio = Math.min(3, Math.log(N_target / N_last));
    for (let i = 0; i < T; i++) {
      if (pinned[i]) {
        sigmas[i] = 0.05;
      } else {
        let sigma = Math.min(1.6, Math.max(0.55, 1.15 * sigma_backtest[i] + 0.1 * lnRatio));
        if (finalRates[i] <= 0.05) sigma = Math.max(sigma, 0.9);
        sigmas[i] = sigma;
      }
    }
  }

  // Step 8: Quantiles
  const z = [-1.645, -0.674, 0, 0.674, 1.645];
  const result = { trophies: [] as Array<{ id: number; q: number[] }> };

  for (let i = 0; i < T; i++) {
    let q: number[];
    if (pinned[i]) {
      q = [99.5, 99.9, 99.99, 99.99, 99.99];
    } else {
      const m = medians[i];
      const sigma = sigmas[i];
      const l = logit(m);
      q = z.map(zi => invLogit(l + zi * sigma));
      // Enforce non-decreasing
      for (let j = 1; j < 5; j++) {
        if (q[j] < q[j - 1]) q[j] = q[j - 1];
      }
      // Round to 4 decimals
      q = q.map(v => Math.round(v * 10000) / 10000);
    }
    result.trophies.push({ id: trophies[i].id, q });
  }

  // Ensure output directory
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(result));
}

main();

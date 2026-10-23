// Kitchen Brain maths: small, explainable models that learn from one kitchen's own data.
// No outside AI: every number can be traced back to that shop's bills and stock log.

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
export function stats(a) {
  const mean = avg(a);
  const std = a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / (a.length - 1)) : 0;
  return { mean, std };
}

// Daily demand with a weekly pattern (Saturday ≠ Tuesday) and a gentle trend:
// Holt-Winters exponential smoothing, additive weekday effects, damped trend.
// y: daily amounts (oldest first, one per day, zeros included); wd: weekday (0 = Sunday) of each day.
export function learnSeries(y, wd, { alpha = 0.3, beta = 0.05, gamma = 0.25, phi = 0.9 } = {}) {
  const n = y.length;
  if (!n) return null;
  const weekly = n >= 14; // two of each weekday before trusting the pattern
  const mean = avg(y);
  const season = Array(7).fill(0);
  if (weekly) {
    for (let d = 0; d < 7; d++) {
      const vals = y.filter((_, i) => wd[i] === d);
      if (vals.length) season[d] = avg(vals) - mean;
    }
  }
  let level = avg(y.slice(0, Math.min(7, n)).map((v, i) => v - season[wd[i]]));
  let trend = 0;
  let sse = 0;
  let errs = 0;
  for (let t = 0; t < n; t++) {
    const s = season[wd[t]];
    const pred = level + phi * trend + s;
    if (t >= 7) (sse += (y[t] - pred) ** 2), errs++;
    const prev = level;
    level = alpha * (y[t] - s) + (1 - alpha) * (level + phi * trend);
    trend = beta * (level - prev) + (1 - beta) * phi * trend;
    if (weekly) season[wd[t]] = gamma * (y[t] - level) + (1 - gamma) * s;
  }
  return { level, trend, season, phi, weekly, n, rmse: errs ? Math.sqrt(sse / errs) : 0 };
}

// Expected amount on a day `h` days after the last one learned (h = 1 is the next day).
export function predict(m, weekday, h = 1) {
  if (!m) return 0;
  let damp = 0;
  for (let k = 1; k <= h; k++) damp += m.phi ** k;
  return Math.max(0, m.level + damp * m.trend + m.season[weekday]);
}

// Reorder when stock covers only the supplier's delay plus a safety margin for busy days.
// z = 1.65 → enough on ~95% of days.
export function reorderPoint({ mean, std, leadDays = 1, z = 1.65 }) {
  return mean * leadDays + z * std * Math.sqrt(leadDays);
}

// Typical supplier delay from past "running out → received" gaps (days). Median resists one-offs.
export function leadTime(gaps, fallback = 1) {
  const g = gaps.filter((x) => x > 0 && x < 7).sort((a, b) => a - b);
  if (!g.length) return fallback;
  const mid = g.length >> 1;
  const m = g.length % 2 ? g[mid] : (g[mid - 1] + g[mid]) / 2;
  return Math.min(7, Math.max(0.25, m));
}

// How unusual x is compared with this kitchen's own history (0 = normal, 3 = very unusual).
// The spread has a floor so a quiet history doesn't make every small change look alarming.
export function zScore(x, history) {
  const { mean, std } = stats(history);
  const spread = Math.max(std, mean * 0.25, 1e-9);
  return (x - mean) / spread;
}

// Recipe check from stock counts: `missing` is how much less was counted than expected over a
// period, `used` what recipes say was used in it. 0.12 → recipes use ~12% more than written.
export function calibration(missing, used) {
  if (!(used > 0)) return null;
  const ratio = missing / used;
  return { ratio, factor: Math.min(1.5, Math.max(0.7, 1 + ratio)) };
}

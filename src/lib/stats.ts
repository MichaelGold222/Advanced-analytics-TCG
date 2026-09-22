/** Small, dependency-free statistics helpers used by the analytics engine. */

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Linear-interpolated percentile. `p` is 0-1. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN
  if (xs.length === 1) return xs[0]
  const s = [...xs].sort((a, b) => a - b)
  const idx = clamp(p, 0, 1) * (s.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return s[lo]
  return s[lo] + (s[hi] - s[lo]) * (idx - lo)
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)
  return Math.sqrt(v)
}

/** Median absolute deviation, scaled to be comparable with a standard deviation. */
export function mad(xs: number[]): number {
  if (xs.length === 0) return NaN
  const m = median(xs)
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)))
}

/**
 * Drop points far from the median. Uses MAD, which a couple of wild
 * outliers cannot inflate the way they inflate a standard deviation.
 * Below `minSample` points every value is kept: with a handful of comps
 * we cannot tell an outlier from the actual market.
 */
export function rejectOutliers<T>(
  items: T[],
  value: (t: T) => number,
  threshold = 3,
  minSample = 5,
): { kept: T[]; dropped: T[] } {
  if (items.length < minSample) return { kept: items, dropped: [] }
  const vals = items.map(value)
  const m = median(vals)
  const d = mad(vals)
  // A zero MAD means most points are identical; fall back to a relative band.
  const band = d > 0 ? threshold * d : Math.max(m * 0.5, 0.01)
  const kept: T[] = []
  const dropped: T[] = []
  for (const it of items) (Math.abs(value(it) - m) <= band ? kept : dropped).push(it)
  return kept.length ? { kept, dropped } : { kept: items, dropped: [] }
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

export function clamp01(x: number): number {
  return clamp(x, 0, 1)
}

/** Least-squares slope of y against x, or null when it is not defined. */
export function slope(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length)
  if (n < 2) return null
  const mx = mean(xs.slice(0, n))
  const my = mean(ys.slice(0, n))
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) ** 2
  }
  if (den === 0) return null
  return num / den
}

/**
 * There is deliberately no general `annualizedVolatility` here.
 *
 * Scaling a log return by the root of the ACTUAL day gap — the obvious
 * implementation, and the one that used to live at this spot — reads two
 * buyers paying a few per cent apart on consecutive days as the card moving
 * that far in a day, and annualizes it into the hundreds of per cent. It was
 * invisible while cards had five sales apiece and became the headline figure
 * the moment a backfill gave them hundreds.
 *
 * Volatility is measured by `dailyReturns` in forecast.ts, which floors the
 * spacing at `MIN_GAP_DAYS`, over the prices `bandEvidence` admits.
 */

export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(b) - Date.parse(a)
  if (Number.isNaN(ms)) return 0
  return ms / 86_400_000
}

export function daysAgo(date: string, now = new Date()): number {
  const ms = now.getTime() - Date.parse(date)
  if (Number.isNaN(ms)) return 0
  return Math.max(0, ms / 86_400_000)
}

export function toISODate(d: Date | string | number): string {
  const date = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 10)
}

/** Exponential decay weight: 1.0 today, 0.5 at `halfLife` days old. */
export function recencyWeight(ageDays: number, halfLife: number): number {
  if (halfLife <= 0) return 1
  return Math.pow(0.5, Math.max(0, ageDays) / halfLife)
}

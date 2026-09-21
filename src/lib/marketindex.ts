/**
 * A price index for the collection, built from cards selling twice.
 *
 * The problem this solves: a single card has six to twelve sales, which is far
 * too few to say what its trend is. But ninety cards have hundreds of sales
 * between them, and most of what any one card does is the whole market moving.
 * Separating the two means the common part gets estimated from everything at
 * once, and only the leftover has to come from one card's thin record.
 *
 * You cannot compare a Lugia to a Charizard — different cards, different
 * prices, no common scale. You *can* compare a Lugia to itself at two dates,
 * and that comparison holds the card fixed, so whatever is left is the market.
 * Stack one equation per repeat sale and solve for the level at each date, and
 * the result is a market index built only from like-for-like comparisons. This
 * is the repeat-sales method — Bailey, Muth and Nourse in 1963, refined by
 * Case and Shiller in 1987 — and it exists precisely for assets that are
 * expensive, individually distinct, and sell rarely. Houses, art, and this.
 *
 * Three refinements matter at this sample size:
 *
 * **A random-walk prior, not a ridge.** With a few hundred pairs across two
 * dozen months, some months will be thin or empty. Penalizing the *level*
 * toward zero would drag those months toward whatever the base period was,
 * which is meaningless. Penalizing the period-to-period *change* instead says
 * the index probably did not lurch, which is a real belief about markets, and
 * lets a quiet month interpolate between its neighbours rather than inventing a
 * spike. The penalty is worth half a sale, so a period with any real data
 * barely notices it and an empty one is decided by it. It is kept that weak on
 * purpose: at two sales it visibly flattened a genuine peak, and an index that
 * misses a turn is worse than one that wobbles.
 *
 * **Long gaps are noisier than short ones.** A pair two years apart has far
 * more accumulated drift in it than a pair two weeks apart, so treating both as
 * equally informative overweights the stale ones. Case and Shiller's remedy is
 * to fit how residual variance grows with the gap and re-weight by it, which is
 * the third stage below.
 *
 * **One card's disaster is not the market's.** A pair the first pass cannot
 * explain at all — a slab that lost most of its value while everything around
 * it rose — is a regrade, a crack, a mis-keyed cert or a raw price in a graded
 * series. It is dropped before the real fit, because a handful left in will
 * drag whole periods.
 */
import { daysBetween, mad, mean, stdev, toISODate } from './stats'
import type { PricePoint, PriceSeries, PriceSource } from './types'

/** Target pairs per bucket before the index widens its periods. */
const TARGET_PAIRS_PER_BUCKET = 6

/** Bucket widths tried in order, from finest to coarsest. */
const PERIOD_CHOICES = [30, 91, 182]

/**
 * Strength of the random-walk prior, in units of repeat sales.
 *
 * Half a sale. Deliberately weak: it exists to stop an empty period inventing
 * a spike, not to talk a real turn in the market out of the data. At two it
 * visibly flattened a genuine peak, which is the failure that matters more.
 */
const SMOOTHING_PAIRS = 0.5

/**
 * Residuals beyond this many robust deviations are not the market.
 *
 * A card that lost seventy per cent while everything around it rose is telling
 * you about that card — a regrade, a cracked slab, a cert typed in wrong, a raw
 * price that slipped into a graded series. Repeat-sales indices have trimmed
 * such pairs since Case and Shiller, because one of them left in can drag a
 * whole period, and the scale is set by the median deviation so the outliers
 * cannot widen the gate that is meant to catch them.
 */
const OUTLIER_DEVIATIONS = 3

/**
 * Floor under the robust scale, in logs, so the gate cannot close completely.
 *
 * Without it the trimming eats the pairs it most needs. When a run of sales
 * happens to fit the fitted index almost exactly — a quiet stretch, a cluster
 * of near-identical comps — the median deviation collapses toward zero and
 * three deviations with it, so the handful of long pairs carrying the market
 * across a gap look like outliers next to their tidy neighbours and are thrown
 * out. That is precisely backwards: they are the only evidence about the gap.
 *
 * A third of a log either way is roughly a forty per cent unexplained move,
 * which in this market is an ordinary result and never an anomaly worth
 * dropping. On real data the measured scale exceeds this and the floor does
 * nothing; it only binds when the data is suspiciously clean.
 */
const MIN_RESIDUAL_SIGMA = 0.11

/** Below this many pairs there is no index worth having. */
export const MIN_PAIRS_FOR_INDEX = 12

/** Below this many distinct cards, an "index" is really just one card. */
export const MIN_CARDS_FOR_INDEX = 4

/**
 * Which observations count as a price this card actually changed hands at.
 *
 * Completed sales obviously. Dated columns from the owner's own sheet too:
 * those are a price recorded for one specific card on one specific date, which
 * is exactly what a repeat-sales pair is made of, and excluding them would
 * hide this whole feature from anyone who has not fetched prices yet — which
 * is most people, most of the time.
 *
 * Everything else is deliberately out. A market quote, an active ask and a
 * midpoint are opinions about a price rather than one that was paid, and a
 * snapshot is this app recording a quote on a past run — including those would
 * manufacture a repeat sale every time the page was opened.
 */
const PAIRABLE_SOURCES = new Set<PriceSource>(['sale', 'user'])

export interface RepeatSale {
  key: string
  fromDate: string
  toDate: string
  /** Log price change across the pair. */
  logReturn: number
  gapDays: number
}

export interface IndexPoint {
  /** Midpoint of the period, which is where the level is taken to apply. */
  date: string
  /** Log level, with the first period fixed at zero. */
  logLevel: number
  /** Repeat sales whose span touched this period. */
  pairs: number
}

export interface MarketIndex {
  points: IndexPoint[]
  periodDays: number
  pairCount: number
  /** Pairs thrown out as being about one card rather than the market. */
  trimmed: number
  cardCount: number
  /** Annualized log drift across the index's span. */
  driftPerYear: number
  /** Annualized volatility of the index's own period-to-period moves. */
  volatility: number
  /** Period-to-period log changes, scaled to one day. Resampled when simulating. */
  dailyMoves: number[]
}

/**
 * Consecutive sale pairs for one card.
 *
 * Consecutive rather than every combination: pairing each sale with the next
 * keeps the errors roughly independent, where pairing all with all would reuse
 * the same sale in many rows and make a handful of cards look like a crowd.
 */
export function repeatSalesFor(key: string, series: PriceSeries): RepeatSale[] {
  const sales = series.points
    .filter((p) => PAIRABLE_SOURCES.has(p.source) && p.price > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
  const out: RepeatSale[] = []
  for (let i = 1; i < sales.length; i++) {
    const gapDays = daysBetween(sales[i - 1].date, sales[i].date)
    if (gapDays <= 0) continue
    out.push({
      key,
      fromDate: sales[i - 1].date,
      toDate: sales[i].date,
      logReturn: Math.log(sales[i].price / sales[i - 1].price),
      gapDays,
    })
  }
  return out
}

export function collectRepeatSales(seriesByKey: Map<string, PriceSeries>): RepeatSale[] {
  const out: RepeatSale[] = []
  for (const [key, series] of seriesByKey) out.push(...repeatSalesFor(key, series))
  return out
}

/** Solve a symmetric positive-definite system by Cholesky, or null if it is not. */
function solveSpd(a: number[][], b: number[]): number[] | null {
  const n = b.length
  const l: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i][j]
      for (let k = 0; k < j; k++) sum -= l[i][k] * l[j][k]
      if (i === j) {
        if (!(sum > 1e-12)) return null
        l[i][i] = Math.sqrt(sum)
      } else {
        l[i][j] = sum / l[j][j]
      }
    }
  }
  const y = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    let sum = b[i]
    for (let k = 0; k < i; k++) sum -= l[i][k] * y[k]
    y[i] = sum / l[i][i]
  }
  const x = new Array<number>(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i]
    for (let k = i + 1; k < n; k++) sum -= l[k][i] * x[k]
    x[i] = sum / l[i][i]
  }
  return x
}

interface Row {
  from: number
  to: number
  y: number
  gapDays: number
}

/**
 * One weighted least-squares pass over the design.
 *
 * Parameters are the levels of periods 1..k-1; period 0 is fixed at zero
 * because only differences are identifiable — an index has no natural origin,
 * so one has to be chosen.
 */
function fitLevels(rows: Row[], buckets: number, weights: number[], lambda: number): number[] | null {
  const n = buckets - 1
  if (n < 1) return null
  const a: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  const rhs = new Array<number>(n).fill(0)

  rows.forEach((row, i) => {
    const w = weights[i]
    // Column index of a period in the parameter vector; period 0 has none.
    const to = row.to - 1
    const from = row.from - 1
    if (to >= 0) {
      a[to][to] += w
      rhs[to] += w * row.y
    }
    if (from >= 0) {
      a[from][from] += w
      rhs[from] -= w * row.y
    }
    if (to >= 0 && from >= 0) {
      a[to][from] -= w
      a[from][to] -= w
    }
  })

  // Random-walk prior: penalize each period-to-period change, including the
  // first one out of the fixed base period.
  a[0][0] += lambda
  for (let t = 1; t < n; t++) {
    a[t][t] += lambda
    a[t - 1][t - 1] += lambda
    a[t][t - 1] -= lambda
    a[t - 1][t] -= lambda
  }

  return solveSpd(a, rhs)
}

/**
 * Build the index, or null when the collection cannot support one.
 *
 * Refuses rather than guesses in two cases that look like data but are not: too
 * few repeat sales overall, and too few distinct cards — a dozen pairs that all
 * come from two cards is those two cards' history wearing the word "market".
 */
export function buildRepeatSalesIndex(
  seriesByKey: Map<string, PriceSeries>,
  now = new Date(),
): MarketIndex | null {
  const all = collectRepeatSales(seriesByKey)
  if (all.length < MIN_PAIRS_FOR_INDEX) return null
  if (new Set(all.map((r) => r.key)).size < MIN_CARDS_FOR_INDEX) return null

  const origin = all.reduce((min, r) => (r.fromDate < min ? r.fromDate : min), all[0].fromDate)
  const last = all.reduce((max, r) => (r.toDate > max ? r.toDate : max), all[0].toDate)
  const spanDays = daysBetween(origin, last)
  if (spanDays <= 0) return null

  // Widen the periods until each one has enough pairs crossing it to be worth
  // estimating. A monthly index off two hundred sales is mostly noise.
  let periodDays = PERIOD_CHOICES[PERIOD_CHOICES.length - 1]
  for (const candidate of PERIOD_CHOICES) {
    const buckets = Math.floor(spanDays / candidate) + 1
    if (buckets >= 2 && all.length / buckets >= TARGET_PAIRS_PER_BUCKET) {
      periodDays = candidate
      break
    }
  }

  const buckets = Math.floor(spanDays / periodDays) + 1
  if (buckets < 2) return null
  const bucketOf = (date: string) =>
    Math.min(buckets - 1, Math.max(0, Math.floor(daysBetween(origin, date) / periodDays)))

  const rows: Row[] = []
  for (const r of all) {
    const from = bucketOf(r.fromDate)
    const to = bucketOf(r.toDate)
    // Both sales inside one period say nothing about movement between periods.
    if (from === to) continue
    rows.push({ from, to, y: r.logReturn, gapDays: r.gapDays })
  }
  if (rows.length < MIN_PAIRS_FOR_INDEX) return null

  const lambda = SMOOTHING_PAIRS
  const levelAt = (levels: number[], bucket: number) => (bucket === 0 ? 0 : levels[bucket - 1])
  const residualsAgainst = (levels: number[], against: Row[]) =>
    against.map((r) => r.y - (levelAt(levels, r.to) - levelAt(levels, r.from)))

  // Stage one: every pair counted equally, to get residuals worth judging.
  const flat = new Array<number>(rows.length).fill(1)
  const first = fitLevels(rows, buckets, flat, lambda)
  if (!first) return null

  // Trim the pairs the first pass could not explain at all, then refit without
  // them. A card whose own story swamps the market's is evidence about that
  // card, and leaving it in moves periods it has no business moving.
  const firstResid = residualsAgainst(first, rows)
  const sigma = Math.max(MIN_RESIDUAL_SIGMA, 1.4826 * mad(firstResid))
  const kept = rows.filter((_, i) => Math.abs(firstResid[i]) <= OUTLIER_DEVIATIONS * sigma)
  const used = kept.length >= MIN_PAIRS_FOR_INDEX ? kept : rows
  const trimmed = rows.length - used.length
  const base = trimmed > 0 ? (fitLevels(used, buckets, new Array<number>(used.length).fill(1), lambda) ?? first) : first

  // Stage two: fit how residual variance grows with the gap. A pair held two
  // years has more unexplained movement in it than one held two weeks, and
  // pretending otherwise lets the stale pairs shout.
  const resid = residualsAgainst(base, used)
  const gaps = used.map((r) => r.gapDays)
  const sq = resid.map((e) => e * e)
  const gapMean = mean(gaps)
  const sqMean = mean(sq)
  let cov = 0
  let varGap = 0
  for (let i = 0; i < used.length; i++) {
    cov += (gaps[i] - gapMean) * (sq[i] - sqMean)
    varGap += (gaps[i] - gapMean) ** 2
  }
  const slopePerDay = varGap > 0 ? Math.max(0, cov / varGap) : 0
  const intercept = Math.max(1e-6, sqMean - slopePerDay * gapMean)

  // Stage three: refit, each pair weighted by how precise its gap makes it.
  const weights = used.map((r) => 1 / (intercept + slopePerDay * r.gapDays))
  const scale = mean(weights)
  const levels = fitLevels(used, buckets, weights.map((w) => w / scale), lambda) ?? base

  const originMs = new Date(`${origin}T00:00:00Z`).getTime()
  const crossing = new Array<number>(buckets).fill(0)
  for (const r of used) for (let t = r.from; t <= r.to; t++) crossing[t]++

  const points: IndexPoint[] = []
  for (let t = 0; t < buckets; t++) {
    const midMs = originMs + (t + 0.5) * periodDays * 86_400_000
    points.push({
      date: toISODate(new Date(midMs)),
      logLevel: levelAt(levels, t),
      pairs: crossing[t],
    })
  }

  const moves: number[] = []
  for (let t = 1; t < points.length; t++) {
    moves.push((points[t].logLevel - points[t - 1].logLevel) / periodDays)
  }
  const perYear = 365 / periodDays
  const volatility = moves.length >= 2 ? stdev(moves.map((m) => m * periodDays)) * Math.sqrt(perYear) : 0
  const totalSpanYears = ((points.length - 1) * periodDays) / 365
  const driftPerYear = totalSpanYears > 0
    ? (points[points.length - 1].logLevel - points[0].logLevel) / totalSpanYears
    : 0

  void now
  return {
    points,
    periodDays,
    pairCount: used.length,
    trimmed,
    cardCount: new Set(all.map((r) => r.key)).size,
    driftPerYear,
    volatility,
    dailyMoves: moves,
  }
}

/**
 * The index's log level on a given date, interpolated between period midpoints.
 *
 * Flat beyond either end rather than extrapolated: the index knows nothing
 * about dates it has no sales for, and continuing its last slope outward would
 * be inventing exactly the trend this whole exercise exists to measure.
 */
export function indexLevelAt(index: MarketIndex, date: string): number {
  const pts = index.points
  if (pts.length === 0) return 0
  if (date <= pts[0].date) return pts[0].logLevel
  const lastPoint = pts[pts.length - 1]
  if (date >= lastPoint.date) return lastPoint.logLevel
  for (let i = 1; i < pts.length; i++) {
    if (date <= pts[i].date) {
      const span = daysBetween(pts[i - 1].date, pts[i].date)
      if (span <= 0) return pts[i].logLevel
      const t = daysBetween(pts[i - 1].date, date) / span
      return pts[i - 1].logLevel + t * (pts[i].logLevel - pts[i - 1].logLevel)
    }
  }
  return lastPoint.logLevel
}

/** How far the index moved between two dates, in logs. */
export function indexChangeBetween(index: MarketIndex, from: string, to: string): number {
  return indexLevelAt(index, to) - indexLevelAt(index, from)
}

/** Below this many pairs, a card's relationship to the market is unmeasurable. */
export const MIN_PAIRS_FOR_BETA = 3

/**
 * How much evidence it takes to trust a card's own beta rather than assuming
 * it moves with the market.
 */
export const BETA_SHRINK_STRENGTH = 6

/**
 * Correlation between the two regressors past which they are one regressor.
 *
 * If the market only ever went up a steady amount per day, then "moves twice as
 * hard as a market that rose thirty per cent" and "moves with the market and
 * has thirty per cent of its own" are not two hypotheses — they are the same
 * numbers twice, and least squares will pick between them on rounding error.
 * Beta is identifiable only because the market has shape: it sped up, stalled,
 * turned. When it has none across a card's sales, the honest answer is that
 * this card's sensitivity cannot be measured here.
 */
const MAX_COLLINEARITY = 0.97

/**
 * How much the market must actually vary across a card's intervals, in logs,
 * before its sensitivity to the market can be measured at all.
 *
 * Three per cent. Below that the market column is not a variable, it is a
 * constant with the index's own estimation wobble on top, and regressing
 * against a wobble returns a beta made entirely of it. The test that caught
 * this had a market rising in a perfect line and a card sampled at even
 * intervals: every market move identical, every remaining difference noise,
 * and a confident beta produced from nothing at all.
 */
const MIN_MARKET_SPREAD = 0.03

export interface MarketBeta {
  /** Sensitivity to the market, shrunk toward one. */
  beta: number
  rawBeta: number
  /** Card-specific drift per day, before any shrinking. The caller shrinks it. */
  rawAlphaPerDay: number
  /** Annualized volatility of what the market does not explain. */
  idiosyncratic: number
  /** Share of this card's movement the market accounts for, 0 to 1. */
  marketShare: number
  /**
   * False when the market's path over this card's sales was too close to a
   * straight line to tell its sensitivity apart from its own drift.
   */
  separable: boolean
  sampleSize: number
  /** Calendar days from the card's first sale to its last. */
  spanDays: number
  /**
   * What the market did not explain, per interval, scaled to one day. These
   * are resampled when simulating, so the card's own shape survives.
   */
  residuals: number[]
}

/**
 * Split a card's moves into the market's part and its own.
 *
 * Each repeat sale gives one equation: what the card did over an interval
 * against what the index did over the same interval, plus whatever drift the
 * card carries on its own. Fitting both at once is a two-parameter regression,
 * weighted by interval length because a move over a year has a year's worth of
 * accumulated noise in it and a move over a fortnight does not.
 *
 * Beta is then pulled toward one. Ten observations cannot distinguish a card
 * that moves 1.4 times the market from one that moves with it, and assuming
 * every card is exactly average is a better mistake than believing a beta of
 * 2.3 read off nine sales. What comes back is deliberately closer to one than
 * the raw fit, and `rawBeta` is kept so the difference can be shown.
 *
 * The card's sales also helped build the index, which makes this very slightly
 * self-referential. With dozens of cards contributing, one card's pull on the
 * index it is being measured against is small, and the alternative — an index
 * rebuilt without each card in turn — costs far more than the bias is worth.
 */
export function estimateBeta(points: PricePoint[], index: MarketIndex): MarketBeta | null {
  const pairs = repeatSalesFor('', { key: '', points })
  if (pairs.length < MIN_PAIRS_FOR_BETA) return null

  const spanDays = daysBetween(pairs[0].fromDate, pairs[pairs.length - 1].toDate)
  const rows = pairs.map((p) => ({
    market: indexChangeBetween(index, p.fromDate, p.toDate),
    days: p.gapDays,
    y: p.logReturn,
    // Variance grows with elapsed time, so precision falls with it.
    w: 1 / p.gapDays,
  }))

  let s11 = 0
  let s12 = 0
  let s22 = 0
  let b1 = 0
  let b2 = 0
  for (const r of rows) {
    s11 += r.w * r.market * r.market
    s12 += r.w * r.market * r.days
    s22 += r.w * r.days * r.days
    b1 += r.w * r.market * r.y
    b2 += r.w * r.days * r.y
  }
  const det = s11 * s22 - s12 * s12

  // How much the market's path over these intervals is just elapsed time
  // wearing a different name.
  const totalW = rows.reduce((a, r) => a + r.w, 0)
  const wMean = (f: (r: typeof rows[number]) => number) =>
    rows.reduce((a, r) => a + r.w * f(r), 0) / totalW
  const mMean = wMean((r) => r.market)
  const dMean = wMean((r) => r.days)
  let cov = 0
  let varM = 0
  let varD = 0
  for (const r of rows) {
    cov += r.w * (r.market - mMean) * (r.days - dMean)
    varM += r.w * (r.market - mMean) ** 2
    varD += r.w * (r.days - dMean) ** 2
  }
  // A market that did not move cannot be regressed against at all. But a
  // *constant* interval length is not collinear with anything — it is simply an
  // intercept, and the fit is perfectly well conditioned beside it. Treating
  // that case as degenerate, which correlation does when it divides by a zero
  // spread, refuses every card whose sales happen to be evenly spaced.
  const collinearity = varM <= 1e-18
    ? 1
    : varD <= 1e-18
      ? 0
      : Math.abs(cov / Math.sqrt(varM * varD))

  // What is left of the market's variation once elapsed time has had its
  // share. This, not the raw spread, is what beta is actually estimated from.
  const spread = Math.sqrt(Math.max(0, varD > 1e-18 ? varM - (cov * cov) / varD : varM) / totalW)

  // Three ways the split can fail, all with the same honest answer: assume an
  // ordinary card. The index barely moved; the arithmetic is dividing by
  // nothing; or the market's path and elapsed time are the same variable.
  const identifiable = Math.abs(det) > 1e-12
    && s11 > 1e-12
    && collinearity < MAX_COLLINEARITY
    && spread > MIN_MARKET_SPREAD
  const rawBeta = identifiable ? (s22 * b1 - s12 * b2) / det : 1
  // With beta assumed to be one, whatever the market did not account for is
  // the card's own drift, and a weighted average over the intervals is the
  // best reading of it available.
  const rawAlphaPerDay = identifiable
    ? (s11 * b2 - s12 * b1) / det
    : (s22 > 1e-12 ? rows.reduce((a, r) => a + r.w * r.days * (r.y - r.market), 0) / s22 : 0)

  const weight = rows.length / (rows.length + BETA_SHRINK_STRENGTH)
  const beta = identifiable ? weight * rawBeta + (1 - weight) : 1

  // Residuals, put on a common daily footing so intervals of different lengths
  // can be compared at all.
  const scaledResid = rows.map((r) => (r.y - beta * r.market - rawAlphaPerDay * r.days) / Math.sqrt(r.days))
  const scaledTotal = rows.map((r) => r.y / Math.sqrt(r.days))
  const idiosyncratic = scaledResid.length >= 2 ? stdev(scaledResid) * Math.sqrt(365) : 0
  const totalVol = scaledTotal.length >= 2 ? stdev(scaledTotal) * Math.sqrt(365) : 0
  const marketShare = identifiable && totalVol > 1e-9
    ? Math.min(1, Math.max(0, 1 - (idiosyncratic * idiosyncratic) / (totalVol * totalVol)))
    : 0

  return {
    beta, rawBeta, rawAlphaPerDay, idiosyncratic, marketShare,
    separable: identifiable, sampleSize: rows.length, spanDays,
    residuals: scaledResid,
  }
}

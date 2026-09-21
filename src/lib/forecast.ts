/**
 * What a card might be worth later, and how sure that can be.
 *
 * The data is the constraint and the method has to respect it: five to ten
 * sales per card, at irregular intervals, from a market with no continuous
 * quote. Three consequences follow, and they shape everything here.
 *
 * **Volatility is realized, never implied.** Implied volatility is backed out
 * of option prices — it is the market's own forecast, read off what people pay
 * to hedge. Nothing trades options on a graded card, so there is nothing to
 * back out. What can be measured is how much the observed prices have actually
 * moved, which is a different and more modest quantity.
 *
 * **The simulation resamples real returns rather than assuming a shape.** A
 * textbook Monte Carlo draws from a lognormal, which asserts that returns are
 * bell-shaped around a drift. Six observations cannot support that assertion,
 * and a card market plainly violates it — moves cluster and jump. Resampling
 * the moves that actually happened assumes only that the future resembles the
 * past, which is the weakest assumption available that still says anything.
 *
 * **A thin estimate is pulled toward its segment.** A card with four sales
 * that happen to be calm should not be reported as calm; one with four wild
 * sales is not necessarily wild. Both are shrunk toward the typical volatility
 * of their segment in proportion to how little evidence they carry, which is
 * the standard remedy for a small sample and the single biggest improvement
 * available here.
 *
 * None of that makes a forecast reliable. It makes it honest about not being
 * reliable, which is why every result carries what it was built from and why
 * `computeForecast` returns null rather than guess when a card is too thin.
 */
import { clamp, daysBetween, mean, median, stdev } from './stats'
import type { ForecastResult, PricePoint } from './types'

/** Below this many usable returns, a forecast would be arithmetic on noise. */
export const MIN_RETURNS_FOR_FORECAST = 4

/** Paths per simulation. Enough for stable deciles, cheap enough to run inline. */
export const SIM_PATHS = 2000

/** Volatility assumed for a card with no evidence of its own, before shrinking. */
export const PRIOR_VOLATILITY = 0.45

/**
 * How much evidence it takes to trust a card's own volatility.
 *
 * With this many returns the estimate carries half the weight and the prior
 * the other half; with far more, the prior all but disappears.
 */
export const SHRINK_STRENGTH = 8

/**
 * Prior spread of the *true* annual trend across cards, before seeing any.
 *
 * Cards do genuinely trend — a vintage grade can run for years — so this is
 * not zero. But a fifth a year either way covers most of what the market
 * actually does over a holding period, and anything wider would let a noisy
 * estimate through unchallenged.
 */
export const PRIOR_DRIFT_SPREAD = 0.2

export interface DailyReturn {
  /** Log return scaled to one day, so irregular gaps compare. */
  rate: number
  gapDays: number
}

/**
 * Day-scaled log returns between consecutive sales.
 *
 * Dividing by the square root of the gap is what makes a move over ninety days
 * comparable to one over a week: under a random walk, spread grows with the
 * square root of time, so this removes the part of the move that is simply
 * elapsed time rather than disagreement about the price.
 */
export function dailyReturns(points: PricePoint[]): DailyReturn[] {
  const sorted = [...points].filter((p) => p.price > 0).sort((a, b) => a.date.localeCompare(b.date))
  const out: DailyReturn[] = []
  for (let i = 1; i < sorted.length; i++) {
    const gapDays = daysBetween(sorted[i - 1].date, sorted[i].date)
    if (gapDays <= 0) continue
    out.push({ rate: Math.log(sorted[i].price / sorted[i - 1].price) / Math.sqrt(gapDays), gapDays })
  }
  return out
}

/**
 * Volatility pulled toward a prior in proportion to how thin the evidence is.
 *
 * The weight is n / (n + k): four returns give the card's own estimate a third
 * of the say, twenty give it seventy per cent. A card with nothing to say gets
 * the prior outright rather than a number invented for it.
 */
export function shrunkVolatility(returns: DailyReturn[], prior = PRIOR_VOLATILITY): number {
  if (returns.length < 2) return prior
  const own = stdev(returns.map((r) => r.rate)) * Math.sqrt(365)
  const weight = returns.length / (returns.length + SHRINK_STRENGTH)
  return weight * own + (1 - weight) * prior
}

/**
 * Trend as the median of all pairwise slopes — the Theil-Sen estimator.
 *
 * Least squares is pulled around by a single unusual sale, and in a set of six
 * that is a coin flip. The median slope needs about a third of the points to be
 * wrong before it moves, which matches a market where one odd auction result is
 * ordinary.
 */
export function robustDrift(points: PricePoint[]): number | null {
  const s = [...points].filter((p) => p.price > 0).sort((a, b) => a.date.localeCompare(b.date))
  if (s.length < 3) return null
  const first = s[0].date
  const slopes: number[] = []
  for (let i = 0; i < s.length; i++) {
    for (let j = i + 1; j < s.length; j++) {
      const dt = daysBetween(s[i].date, s[j].date)
      if (dt <= 0) continue
      slopes.push((Math.log(s[j].price) - Math.log(s[i].price)) / dt)
    }
  }
  if (slopes.length === 0) return null
  void first
  return median(slopes)
}

/**
 * Trend pulled toward zero by how badly the sample determines it.
 *
 * Volatility and trend are not equally knowable, and the gap is not close.
 * The standard error of an annual trend is the volatility divided by the root
 * of the *calendar span* — more sales inside the same two years barely help,
 * because what a trend needs is a longer lever, not a denser one. Volatility's
 * own error falls as the root of the count, so it converges perhaps three or
 * four times faster on a typical card here.
 *
 * Left alone, the noisier of the two quantities sets the headline. A card with
 * six sales scattered along a flat line routinely measures twenty per cent a
 * year with a standard error of eighteen — indistinguishable from nothing —
 * and that number, compounded over a year of simulated days, is what decides
 * whether the forecast reads as confident. So it is shrunk on the same
 * principle volatility is, with the weight taken from how much of the spread
 * is signal rather than error.
 *
 * @param volatility annualized, already shrunk
 * @param spanDays calendar days from the first sale to the last
 */
export function shrunkDrift(
  rawPerDay: number,
  volatility: number,
  spanDays: number,
  spread = PRIOR_DRIFT_SPREAD,
): number {
  if (!(spanDays > 0) || !(volatility > 0)) return 0
  const standardError = volatility / Math.sqrt(spanDays / 365)
  // Signal over signal-plus-noise: all of it when the span is long enough to
  // pin the trend down, almost none of it when the error swamps the prior.
  const weight = (spread * spread) / (spread * spread + standardError * standardError)
  return rawPerDay * weight
}

/**
 * How long the sales run, said the way the cut needs explaining.
 *
 * The span is the whole reason a trend is or is not believable, so the
 * sentence names it rather than reporting a weight nobody can interpret.
 */
function spanLabel(spanDays: number): string {
  const of = (period: string) => `${period} of sales cannot tell a trend that size apart from chance`
  if (spanDays < 120) return of('a few weeks')
  if (spanDays < 400) return of('under a year')
  return of(`${(spanDays / 365).toFixed(1)} years`)
}

/** A deterministic generator, so the same history always yields the same fan. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    // xorshift32: adequate for resampling, and reproducible across machines.
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) % 1_000_000) / 1_000_000
  }
}

/**
 * Simulate forward by resampling the card's own moves.
 *
 * Each path walks day by day, drawing a day-scaled return at random from the
 * ones observed and adding the trend. Drift is capped: a card that happens to
 * have tripled across six sales would otherwise be projected to triple again,
 * which is an artefact of the sample rather than a claim anyone would make.
 */
export function computeForecast(
  points: PricePoint[],
  from: number | null,
  horizons: number[] = [30, 90, 180, 365],
  prior = PRIOR_VOLATILITY,
): ForecastResult | null {
  if (from == null || !(from > 0)) return null
  const returns = dailyReturns(points)
  if (returns.length < MIN_RETURNS_FOR_FORECAST) return null

  const volatility = shrunkVolatility(returns, prior)
  const weight = returns.length / (returns.length + SHRINK_STRENGTH)
  const rawDrift = robustDrift(points) ?? 0
  // How long a lever the sales give the trend, which is what determines it.
  const dated = [...points].filter((p) => p.price > 0).map((p) => p.date).sort()
  const spanDays = dated.length >= 2 ? daysBetween(dated[0], dated[dated.length - 1]) : 0
  const pulledDrift = shrunkDrift(rawDrift, volatility, spanDays)
  // ±60% a year is already an extreme claim; beyond it the number is the
  // sample talking, not the market.
  const driftPerDay = clamp(pulledDrift, -0.6 / 365, 0.6 / 365)
  const driftKept = rawDrift === 0 ? 1 : pulledDrift / rawDrift

  const rates = returns.map((r) => r.rate)
  const centred = rates.map((r) => r - mean(rates))

  // Resample the shape, but at the shrunk volatility rather than the raw one.
  // Six sales along a smooth line have almost no residual spread, and drawing
  // from that would forecast the future as a certainty — the overconfidence
  // shrinking exists to prevent. Rescaling keeps whatever skew and fat tails
  // the card's own moves have while setting their width to the estimate that
  // was actually reported.
  const rawDaily = stdev(centred)
  const targetDaily = volatility / Math.sqrt(365)
  const draws = rawDaily > 1e-9
    ? centred.map((c) => (c * targetDaily) / rawDaily)
    : [-targetDaily, targetDaily]

  const rand = seededRandom(Math.round(from * 1000) + returns.length * 7919)

  const bands = horizons.map((horizonDays) => {
    const ends: number[] = []
    for (let path = 0; path < SIM_PATHS; path++) {
      let logPrice = Math.log(from)
      for (let day = 0; day < horizonDays; day++) {
        const draw = draws[Math.floor(rand() * draws.length) % draws.length]
        logPrice += driftPerDay + draw
      }
      ends.push(Math.exp(logPrice))
    }
    ends.sort((a, b) => a - b)
    const at = (q: number) => ends[Math.min(ends.length - 1, Math.floor(q * ends.length))]
    return {
      horizonDays,
      low: at(0.1),
      mid: at(0.5),
      high: at(0.9),
      chanceUp: ends.filter((e) => e > from).length / ends.length,
    }
  })

  const rationale = [
    `Built from ${returns.length} price moves on this card, resampled rather than assumed to be bell-shaped.`,
    weight < 0.5
      ? `Its own history is thin, so volatility of ${Math.round(volatility * 100)}% leans mostly on what its segment typically does.`
      : `Volatility of ${Math.round(volatility * 100)}% a year across its whole history, pulled slightly toward its segment. The entry call quotes the last year alone, so the two figures differ.`,
    `Trend of ${(driftPerDay * 365 * 100).toFixed(0)}% a year, the median of every pair of sales${
      driftKept < 0.9
        ? ` — cut from ${(rawDrift * 365 * 100).toFixed(0)}%, because ${spanLabel(spanDays)}`
        : ''
    }.`,
    'A range, not a prediction: the bands say where the price lands in 8 of 10 simulated futures.',
  ]

  return { from, volatility, shrunk: weight < 0.5, driftPerYear: driftPerDay * 365, driftShrunk: driftKept < 0.9, sampleSize: returns.length, bands, rationale }
}

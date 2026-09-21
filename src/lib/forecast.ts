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
import { type MarketBeta, type MarketIndex, estimateBeta } from './marketindex'
import { clamp, daysBetween, mean, median, stdev } from './stats'
import type { ForecastResult, PricePoint, Projection } from './types'

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

/**
 * Volatility assumed for a card's *own* movement, once the market's share of it
 * has been taken out. Lower than the total prior, because a good part of what
 * any card does is the whole market moving.
 */
export const PRIOR_IDIOSYNCRATIC = 0.32

/**
 * How long a measured trend keeps half its force when carried forward.
 *
 * Two years. Without a decay, a trend compounds without limit and the long
 * horizons turn to fiction: twenty per cent a year, carried honestly for a
 * decade, is seven times the money, which is not a forecast anyone should
 * publish off nine sales. Nothing sustains a rate like that for a decade, and
 * a two-year record cannot tell you which rare thing will.
 *
 * Decaying it toward nothing caps the total a trend can ever contribute at
 * about eighteen months of it, however far out the horizon runs. The near
 * term barely changes — the first year keeps most of its trend — and what
 * changes is the decade, which is exactly where a straight extrapolation is
 * most confidently wrong.
 */
export const DRIFT_HALF_LIFE_DAYS = 730

/** Horizons for the long view, in years. */
export const PROJECTION_YEARS = [1, 5, 10]

/** Days per step when projecting years out. Daily steps are needless here. */
const PROJECTION_STEP_DAYS = 30

export interface ForecastOptions {
  horizons?: number[]
  prior?: number
  /** The collection's index, and this card's relationship to it. */
  index?: MarketIndex | null
  /**
   * What a buyer would pay today, against which returns are figured. Defaults
   * to the price the forecast starts from.
   */
  basis?: number | null
  projectionYears?: number[]
}

/**
 * Trend accumulated between two days, with its force decaying as it goes.
 *
 * The closed form of a half-life decay, so a path does not have to be walked
 * to know what the trend contributed over a stretch of it.
 */
export function cumulativeDrift(
  driftPerDay: number,
  fromDay: number,
  toDay: number,
  halfLifeDays = DRIFT_HALF_LIFE_DAYS,
): number {
  if (!(halfLifeDays > 0)) return driftPerDay * (toDay - fromDay)
  const k = halfLifeDays / Math.LN2
  return driftPerDay * k * (2 ** (-fromDay / halfLifeDays) - 2 ** (-toDay / halfLifeDays))
}

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

/**
 * Centre a set of observed moves and rescale them to a target volatility.
 *
 * Keeps whatever skew and fat tails the moves actually had while setting their
 * width to the estimate that was reported, rather than to the raw spread of a
 * handful of sales. A set with no spread at all becomes a coin flip of the
 * right size, since resampling zeros would forecast a certainty.
 */
function drawsAt(moves: number[], annualVolatility: number): number[] {
  const targetDaily = annualVolatility / Math.sqrt(365)
  if (moves.length === 0) return [-targetDaily, targetDaily]
  const centred = moves.map((m) => m - mean(moves))
  const raw = stdev(centred)
  if (!(raw > 1e-9)) return [-targetDaily, targetDaily]
  return centred.map((c) => (c * targetDaily) / raw)
}

/**
 * Rebuild a card's drift and volatility out of the market's and its own.
 *
 * This is the whole point of having an index. A card's own trend is measured
 * from nine sales and is mostly noise; the market's is measured from hundreds
 * and survives being shrunk. So the market's drift is taken, scaled by how
 * hard this card moves with it, and only the leftover has to come from the
 * card's thin record — where it is shrunk hard, because a leftover is the
 * least determined quantity in the whole calculation.
 *
 * Volatility composes the same way. The market part is beta times the index's
 * volatility and needs no shrinking, having come from the whole collection.
 * The card's own part does, and is pulled toward a prior that is deliberately
 * below the all-in one, since a good share of any card's movement is already
 * accounted for by the market and must not be counted twice.
 */
function splitAgainstMarket(index: MarketIndex, beta: MarketBeta, weight: number) {
  const indexSpanDays = index.points.length >= 2
    ? (index.points.length - 1) * index.periodDays
    : 0
  // The index earns its drift: hundreds of pairs across a long span, so the
  // same shrinking that flattens a single card leaves most of this intact.
  const marketDriftPerDay = shrunkDrift(
    index.driftPerYear / 365, index.volatility, indexSpanDays,
  )
  const idiosyncratic = weight * beta.idiosyncratic + (1 - weight) * PRIOR_IDIOSYNCRATIC
  const alphaPerDay = shrunkDrift(beta.rawAlphaPerDay, idiosyncratic, beta.spanDays)
  const marketVolatility = index.volatility

  return {
    beta: beta.beta,
    marketVolatility,
    idiosyncratic,
    volatility: Math.hypot(beta.beta * marketVolatility, idiosyncratic),
    marketDriftPerDay,
    alphaPerDay,
    driftPerDay: beta.beta * marketDriftPerDay + alphaPerDay,
    rawDriftPerDay: beta.beta * (index.driftPerYear / 365) + beta.rawAlphaPerDay,
  }
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
  options: ForecastOptions = {},
): ForecastResult | null {
  const {
    horizons = [30, 90, 180, 365], prior = PRIOR_VOLATILITY, index = null,
    basis = null, projectionYears = PROJECTION_YEARS,
  } = options
  if (from == null || !(from > 0)) return null
  const returns = dailyReturns(points)
  if (returns.length < MIN_RETURNS_FOR_FORECAST) return null

  const weight = returns.length / (returns.length + SHRINK_STRENGTH)
  // How long a lever the sales give the trend, which is what determines it.
  const dated = [...points].filter((p) => p.price > 0).map((p) => p.date).sort()
  const spanDays = dated.length >= 2 ? daysBetween(dated[0], dated[dated.length - 1]) : 0

  const beta = index ? estimateBeta(points, index) : null
  const split = index && beta ? splitAgainstMarket(index, beta, weight) : null

  const volatility = split ? split.volatility : shrunkVolatility(returns, prior)
  const rawDrift = split ? split.rawDriftPerDay : (robustDrift(points) ?? 0)
  const pulledDrift = split
    ? split.driftPerDay
    : shrunkDrift(rawDrift, volatility, spanDays)
  // ±60% a year is already an extreme claim; beyond it the number is the
  // sample talking, not the market.
  const driftPerDay = clamp(pulledDrift, -0.6 / 365, 0.6 / 365)
  const driftKept = rawDrift === 0 ? 1 : pulledDrift / rawDrift

  // One factor or two. Without an index everything the card did is its own;
  // with one, the market's moves and the card's leftovers are drawn
  // separately, so the part estimated from hundreds of sales is not diluted
  // by the part estimated from nine.
  const marketDraws = split ? drawsAt(index!.dailyMoves, split.marketVolatility) : null
  const draws = split
    ? drawsAt(beta!.residuals, split.idiosyncratic)
    : drawsAt(returns.map((r) => r.rate), volatility)

  const rand = seededRandom(Math.round(from * 1000) + returns.length * 7919)
  const pick = (pool: number[]) => pool[Math.floor(rand() * pool.length) % pool.length]
  const shock = () => pick(draws) + (marketDraws ? split!.beta * pick(marketDraws) : 0)

  const bands = horizons.map((horizonDays) => {
    const ends: number[] = []
    // The trend's contribution per day, weakening as it goes. Computed once
    // rather than per path, since every path carries the same trend.
    const perDay = Array.from({ length: horizonDays }, (_, d) => cumulativeDrift(driftPerDay, d, d + 1))
    for (let path = 0; path < SIM_PATHS; path++) {
      let logPrice = Math.log(from)
      for (let day = 0; day < horizonDays; day++) logPrice += perDay[day] + shock()
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

  // Drift is a log rate. Said aloud as a percentage it has to be converted, or
  // a card compounding at 1.25 in logs is reported as rising 125% a year when
  // it is really rising 249%.
  const asPct = (x: number) => `${Math.round(x * 100)}%`
  const asRate = (logRate: number) => `${Math.round(Math.expm1(logRate) * 100)}%`
  // The long view. Walking ten years a day at a time, two thousand times over,
  // for every card in a collection is seconds of work for an answer no more
  // precise: the draws are independent, so a month of them can be pooled once
  // and drawn from thereafter. The pool keeps the bootstrap's fat tails, which
  // a normal approximation would quietly throw away.
  const maxYears = Math.max(...projectionYears)
  const steps = Math.ceil((maxYears * 365) / PROJECTION_STEP_DAYS)
  const monthlyPool = Array.from({ length: 600 }, () => {
    let sum = 0
    for (let d = 0; d < PROJECTION_STEP_DAYS; d++) sum += shock()
    return sum
  })
  const stepDrift = Array.from({ length: steps }, (_, i) =>
    cumulativeDrift(driftPerDay, i * PROJECTION_STEP_DAYS, (i + 1) * PROJECTION_STEP_DAYS))
  const wanted = projectionYears.map((y) => ({
    years: y,
    step: Math.min(steps, Math.round((y * 365) / PROJECTION_STEP_DAYS)),
  }))
  const endsByYear = new Map<number, number[]>(wanted.map((w) => [w.years, []]))
  for (let path = 0; path < SIM_PATHS; path++) {
    let logPrice = Math.log(from)
    let next = 0
    for (let i = 0; i < steps; i++) {
      logPrice += stepDrift[i] + monthlyPool[Math.floor(rand() * monthlyPool.length) % monthlyPool.length]
      while (next < wanted.length && wanted[next].step === i + 1) {
        endsByYear.get(wanted[next].years)!.push(Math.exp(logPrice))
        next++
      }
    }
  }

  const basisPrice = basis != null && basis > 0 ? basis : from
  const projections: Projection[] = wanted.map(({ years }) => {
    const ends = (endsByYear.get(years) ?? []).sort((a, b) => a - b)
    const at = (q: number) => ends[Math.min(ends.length - 1, Math.floor(q * ends.length))]
    const low = at(0.1)
    const mid = at(0.5)
    const high = at(0.9)
    const roi = (end: number) => (end / basisPrice) ** (1 / years) - 1
    return {
      years,
      low, mid, high,
      roiLow: roi(low), roiMid: roi(mid), roiHigh: roi(high),
      chanceUp: ends.filter((e) => e > from).length / ends.length,
      chanceAboveBasis: ends.filter((e) => e > basisPrice).length / ends.length,
    }
  })

  const rationale: string[] = [
    `Built from ${returns.length} price moves on this card, resampled rather than assumed to be bell-shaped.`,
  ]

  if (split && beta && index) {
    rationale.push(beta.separable
      ? `About ${asPct(beta.marketShare)} of what this card has done was the whole market moving. It moves ${
        beta.beta > 1.15 ? 'harder than' : beta.beta < 0.85 ? 'less than' : 'roughly with'
      } the market, at ${beta.beta.toFixed(2)} times it.`
      : "The market's path across this card's sales was too straight to tell its sensitivity apart from its own drift, so it is taken to move with the market.")

    rationale.push(`The market's own trend of ${asRate(split.marketDriftPerDay * 365)} a year comes from ${
      index.pairCount
    } paired prices across ${index.cardCount} cards, which is why it survives a scrutiny this card's own handful does not.`)

    rationale.push(`Volatility of ${asPct(volatility)} a year: ${
      asPct(split.beta * split.marketVolatility)
    } of it the market at this card's sensitivity and ${
      asPct(split.idiosyncratic)
    } its own, which come to less than their sum because they do not move in step.`)

    const alpha = split.alphaPerDay * 365
    const ownPart = Math.abs(alpha) < 0.01
      ? `nothing of its own worth carrying, since ${spanLabel(beta.spanDays)}`
      : `${asRate(alpha)} a year of its own${
        driftKept < 0.9 ? `, itself cut down because ${spanLabel(beta.spanDays)}` : ''
      }`
    rationale.push(`Trend of ${asRate(driftPerDay * 365)} a year: the market's, scaled to this card, plus ${ownPart}.`)
  } else {
    rationale.push(weight < 0.5
      ? `Its own history is thin, so volatility of ${asPct(volatility)} leans mostly on what its segment typically does.`
      : `Volatility of ${asPct(volatility)} a year across its whole history, pulled slightly toward its segment. The entry call quotes the last year alone, so the two figures differ.`)

    rationale.push(`Trend of ${asRate(driftPerDay * 365)} a year, the median of every pair of sales${
      driftKept < 0.9
        ? ` — cut from ${asRate(rawDrift * 365)}, because ${spanLabel(spanDays)}`
        : ''
    }.`)
  }

  rationale.push('A range, not a prediction: the bands say where the price lands in 8 of 10 simulated futures.')

  return {
    from,
    volatility,
    shrunk: weight < 0.5,
    driftPerYear: driftPerDay * 365,
    driftShrunk: driftKept < 0.9,
    sampleSize: returns.length,
    bands,
    projections,
    basis: basisPrice,
    market: split && beta && index
      ? {
        beta: split.beta,
        rawBeta: beta.rawBeta,
        marketShare: beta.marketShare,
        separable: beta.separable,
        marketDriftPerYear: split.marketDriftPerDay * 365,
        alphaPerYear: split.alphaPerDay * 365,
        idiosyncratic: split.idiosyncratic,
        cardCount: index.cardCount,
        pairCount: index.pairCount,
      }
      : undefined,
    rationale,
  }
}

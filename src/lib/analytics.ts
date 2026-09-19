/**
 * The valuation engine: fair market value, the trailing-52-week band, and
 * what counts as a good entry.
 *
 * Two principles run through all of it:
 *   - every number carries a confidence and a plain-English rationale, because
 *     an unlabelled estimate off two data points is worse than no estimate;
 *   - nothing is invented. If the history cannot support a 52-week high, the
 *     result says `estimated` rather than quietly reporting the max of three points.
 */
import {
  annualizedVolatility, clamp, clamp01, daysAgo, daysBetween, mad, mean, median, percentile,
  recencyWeight, rejectOutliers, slope, toISODate,
} from './stats'
import type {
  Confidence, EntryResult, EntryVerdict, FmvResult, ItemAnalysis, LastSale, PricePoint,
  PriceSeries, RangeResult,
} from './types'

/** How much each kind of observation is trusted, before recency is applied. */
export const SOURCE_WEIGHTS: Record<PricePoint['source'], number> = {
  market: 1.0,
  sale: 0.95,
  snapshot: 0.7,
  mid: 0.5,
  user: 0.45,
  listing: 0.25,
}

/**
 * Active asks sit above the price things actually clear at, so a listing is
 * corrected downward rather than merely down-weighted - a systematic bias does
 * not average out however many listings you add.
 */
export const LISTING_HAIRCUT = 0.92

/** A 45-day half-life: a six-week-old comp counts half as much as today's. */
export const FMV_HALF_LIFE_DAYS = 45
export const WINDOW_DAYS = 365

/**
 * How many recent sales the median is taken over.
 *
 * For graded cards this is the method that matters: a median of the last few
 * real sales is what the market actually pays, and it is robust to one
 * outlier in a way an average is not. The weighted blend below is only a
 * fallback for items with too few real sales to do this properly.
 */
export const SALES_FOR_MEDIAN = 5
export const MIN_SALES_FOR_MEDIAN = 3

function effectivePrice(p: PricePoint): number {
  return p.source === 'listing' ? p.price * LISTING_HAIRCUT : p.price
}

/** Sales volume is weak evidence of a thicker market; cap its influence at +50%. */
function volumeBoost(volume?: number): number {
  if (!volume || volume <= 0) return 1
  return 1 + Math.min(Math.log10(1 + volume) / 2, 0.5)
}

export function pointsInWindow(points: PricePoint[], now = new Date(), windowDays = WINDOW_DAYS): PricePoint[] {
  return points
    .filter((p) => p.price > 0 && daysAgo(p.date, now) <= windowDays)
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Why there is no value, specifically.
 *
 * "No price data" covers two different situations that need different
 * responses: nothing was ever found for this card, or sales were found but
 * every one of them is older than the valuation window. Reporting them
 * identically leaves a blank cell and no way to act on it.
 */
function noValue(series: PriceSeries, now: Date): FmvResult {
  const base = {
    fmv: null, confidence: 'none' as const, agreement: 0,
    sampleSize: 0, contributors: [],
  }
  const priced = series.points.filter((p) => p.price > 0)
  if (priced.length === 0) {
    return {
      ...base,
      stalenessDays: null,
      rationale: [
        'No sales on record for this item yet.',
        series.quoteExcluded
          ? 'It is a graded slab, so it is priced from sales of that exact certificate — fetch its sold comps, or import them.'
          : 'Import sold comps for it, or run a price refresh.',
      ],
    }
  }

  const newest = priced.reduce((a, b) => (a.date >= b.date ? a : b))
  const age = daysAgo(newest.date, now)
  return {
    ...base,
    stalenessDays: age,
    rationale: [
      `${priced.length} sale${priced.length === 1 ? '' : 's'} on record, but the most recent is from ${newest.date}, ${age} days ago.`,
      `Valuation uses the last ${WINDOW_DAYS} days only, so nothing here is recent enough to price from.`,
      `For reference, that last sale was ${newest.price.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}.`,
    ],
  }
}

export function computeFmv(series: PriceSeries, now = new Date()): FmvResult {
  const windowed = pointsInWindow(series.points, now)
  if (windowed.length === 0) return noValue(series, now)

  return medianOfRecentSales(windowed, now) ?? weightedBlend(windowed, now)
}

/**
 * The primary method: the median of the last few completed sales.
 *
 * Only real sales count. An asking price is not a sale, and a provider's
 * market average is a summary of other people's sales rather than an
 * observation of this item's.
 */
function medianOfRecentSales(windowed: PricePoint[], now: Date): FmvResult | null {
  const sales = windowed
    .filter((p) => p.source === 'sale')
    .sort((a, b) => b.date.localeCompare(a.date))
  if (sales.length < MIN_SALES_FOR_MEDIAN) return null

  const used = sales.slice(0, SALES_FOR_MEDIAN)
  const values = used.map(effectivePrice)
  const fmv = median(values)
  if (!(fmv > 0)) return null

  const spread = mad(values) / fmv
  const agreement = clamp01(1 - spread * 2)
  const stalenessDays = daysAgo(used[0].date, now)
  const oldestUsed = daysAgo(used[used.length - 1].date, now)

  let confidence: Confidence = 'low'
  if (used.length >= SALES_FOR_MEDIAN && stalenessDays <= 60 && agreement >= 0.6) confidence = 'high'
  // Sales that disagree wildly do not become trustworthy by being numerous.
  else if (used.length >= MIN_SALES_FOR_MEDIAN && stalenessDays <= 180 && agreement >= 0.35) confidence = 'medium'

  const rationale = [
    `Median of the last ${used.length} completed sale${used.length === 1 ? '' : 's'}, spanning ${Math.round(oldestUsed - stalenessDays)} days.`,
  ]
  if (sales.length > used.length) rationale.push(`${sales.length - used.length} older sale${sales.length - used.length === 1 ? '' : 's'} on record were not used; only the most recent ${SALES_FOR_MEDIAN} count.`)
  if (used.length < SALES_FOR_MEDIAN) rationale.push(`Fewer than ${SALES_FOR_MEDIAN} sales available, so this is thinner than ideal.`)
  if (stalenessDays > 90) rationale.push(`The newest sale is ${Math.round(stalenessDays)} days old.`)
  if (agreement < 0.5) rationale.push('Those sales varied widely, so the true level is less certain than a single number suggests.')

  return {
    fmv,
    confidence,
    agreement,
    stalenessDays,
    sampleSize: used.length,
    // Equal weight: a median does not favour one sale over another.
    contributors: used.map((p) => ({ source: p.source, value: effectivePrice(p), weight: 1, date: p.date })),
    rationale,
  }
}

/** Fallback for items without enough real sales: blend whatever exists. */
function weightedBlend(windowed: PricePoint[], now: Date): FmvResult {
  const empty: FmvResult = {
    fmv: null, confidence: 'none', agreement: 0, stalenessDays: null,
    sampleSize: 0, contributors: [], rationale: ['No price data for this item yet.'],
  }
  const { kept, dropped } = rejectOutliers(windowed, effectivePrice)
  const contributors = kept.map((p) => {
    const age = daysAgo(p.date, now)
    const weight = SOURCE_WEIGHTS[p.source] * recencyWeight(age, FMV_HALF_LIFE_DAYS) * volumeBoost(p.volume)
    return { source: p.source, value: effectivePrice(p), weight, date: p.date }
  }).filter((c) => c.weight > 0)

  const totalWeight = contributors.reduce((a, c) => a + c.weight, 0)
  if (totalWeight <= 0) return empty
  const fmv = contributors.reduce((a, c) => a + c.value * c.weight, 0) / totalWeight

  const variance = contributors.reduce((a, c) => a + c.weight * (c.value - fmv) ** 2, 0) / totalWeight
  const relSpread = fmv > 0 ? Math.sqrt(variance) / fmv : 1
  const agreement = clamp01(1 - relSpread * 2)

  const stalenessDays = Math.min(...kept.map((p) => daysAgo(p.date, now)))
  const salesOnRecord = kept.filter((p) => p.source === 'sale').length

  // Without enough real sales this can never be more than a rough level,
  // whatever the inputs agree on: none of them is a sale of this item.
  let confidence: Confidence = 'low'
  if (kept.length >= 3 && stalenessDays <= 120 && agreement >= 0.45) confidence = 'medium'

  const rationale: string[] = [
    `Fewer than ${MIN_SALES_FOR_MEDIAN} completed sales on record, so this falls back to a weighted blend of ${kept.length} observation${kept.length === 1 ? '' : 's'} — market quotes, asking prices and anything you entered — rather than a median of real sales.`,
    `Add ${MIN_SALES_FOR_MEDIAN - salesOnRecord} or more sold comps and this switches to the median of the last ${SALES_FOR_MEDIAN} sales.`,
  ]
  if (dropped.length) rationale.push(`Discarded ${dropped.length} outlier${dropped.length === 1 ? '' : 's'} more than 3 MAD from the median.`)
  if (kept.some((p) => p.source === 'listing')) rationale.push(`Active asks were cut ${Math.round((1 - LISTING_HAIRCUT) * 100)}% before blending, since listings sit above where cards actually clear.`)
  if (stalenessDays > 60) rationale.push(`Newest data point is ${Math.round(stalenessDays)} days old.`)

  return { fmv, confidence, agreement, stalenessDays, sampleSize: kept.length, contributors, rationale }
}

/** Half a year, for the shorter of the two high-water marks. */
export const SIX_MONTH_DAYS = 182

/**
 * High, low, and where the current price sits between them.
 *
 * Takes the window so the same measurement serves both the twelve-month and
 * the six-month mark; the confidence gates scale with it, because 120 days of
 * coverage means something different inside a six-month window than a year.
 */
export function computeRange(
  series: PriceSeries,
  reference: number | null,
  now = new Date(),
  windowDays = WINDOW_DAYS,
): RangeResult {
  const windowed = pointsInWindow(series.points, now, windowDays)
  if (windowed.length === 0) {
    return { high: null, low: null, position: null, coverageDays: 0, sampleSize: 0, confidence: 'none', estimated: true }
  }
  const prices = windowed.map(effectivePrice)
  const high = Math.max(...prices)
  const low = Math.min(...prices)
  const coverageDays = daysBetween(windowed[0].date, windowed[windowed.length - 1].date)

  let confidence: Confidence = 'low'
  const wide = coverageDays / windowDays
  if (wide >= 0.82 && windowed.length >= 20) confidence = 'high'
  else if (wide >= 0.33 && windowed.length >= 8) confidence = 'medium'

  const position = reference != null && high > low ? clamp01((reference - low) / (high - low)) : reference != null ? 0.5 : null

  return {
    high, low, position, coverageDays, sampleSize: windowed.length, confidence,
    estimated: wide < 0.25 || windowed.length < 8,
  }
}

/** The twelve-month range, which is what "52-week high" means everywhere else. */
export function compute52WeekRange(series: PriceSeries, reference: number | null, now = new Date()): RangeResult {
  return computeRange(series, reference, now, WINDOW_DAYS)
}

/** Fallback discount demanded when a series is too short to measure volatility. */
export const DEFAULT_DISCOUNT = 0.12

export function computeEntry(
  fmvResult: FmvResult,
  range: RangeResult,
  series: PriceSeries,
  reference: number | null,
  now = new Date(),
): EntryResult {
  const fmv = fmvResult.fmv
  const windowed = pointsInWindow(series.points, now)
  const volatility = annualizedVolatility(windowed.map((p) => ({ date: p.date, price: effectivePrice(p) })))

  // A more volatile asset has to be bought further below fair value to be safe.
  const requiredDiscount = volatility == null ? DEFAULT_DISCOUNT : clamp(volatility * 0.5, 0.06, 0.3)

  const momentum90d = computeMomentum(windowed, now)
  const rationale: string[] = []

  if (fmv == null) {
    return {
      verdict: 'unknown', score: 0, entryPrice: null, stretchEntry: null,
      requiredDiscount, volatility, momentum90d,
      rationale: ['No fair market value could be established, so no entry price can be set.'],
    }
  }

  const discountEntry = fmv * (1 - requiredDiscount)
  // With a real history, blend the model price against where the market has
  // actually traded, so the target is reachable rather than theoretical.
  const prices = windowed.map(effectivePrice)
  const p35 = prices.length >= 8 ? percentile(prices, 0.35) : null
  const entryPrice = p35 != null ? (discountEntry + p35) / 2 : discountEntry

  // The patient bid sits a further discount below the target, but is never
  // proposed below anything the market has actually traded at - and never
  // above the standard target, which a tight yearly low would otherwise cause.
  const rawStretch = entryPrice * (1 - requiredDiscount)
  const stretchEntry = Math.min(entryPrice, Math.max(rawStretch, range.low ?? rawStretch))

  rationale.push(
    volatility == null
      ? `Too little history to measure volatility, so a default ${pct(DEFAULT_DISCOUNT)} discount to FMV is required.`
      : `Annualized volatility of ${pct(volatility)} calls for a ${pct(requiredDiscount)} discount to FMV.`,
  )
  if (p35 != null) rationale.push('Target blends that discount with the 35th percentile of the last year of prices.')
  if (stretchEntry >= entryPrice - 0.005 && range.low != null) {
    rationale.push(`The market has not traded below ${money(range.low)} this year, so there is no deeper bid worth waiting for.`)
  }
  if (range.estimated && range.sampleSize > 0) rationale.push('The 52-week band is built on thin history — treat the high and low as indicative.')
  if (momentum90d != null && momentum90d < -0.12) rationale.push(`Down ${pct(Math.abs(momentum90d))} over 90 days; the band may still be resetting lower, so patience costs little.`)
  if (momentum90d != null && momentum90d > 0.2) rationale.push(`Up ${pct(momentum90d)} over 90 days; entries near the target may not come back.`)

  if (reference == null) {
    return {
      verdict: 'unknown', score: 0, entryPrice, stretchEntry, requiredDiscount, volatility, momentum90d,
      rationale: [...rationale, 'No asking price given, so there is nothing to judge against the target yet.'],
    }
  }

  // 0 at `requiredDiscount` above FMV, ~33 at FMV, 100 at twice the discount below.
  const rel = (fmv - reference) / fmv
  const discountScore = clamp01((rel + requiredDiscount) / (3 * requiredDiscount)) * 100
  const rangeScore = range.position != null ? (1 - range.position) * 100 : null
  const score = Math.round(rangeScore == null ? discountScore : discountScore * 0.6 + rangeScore * 0.4)

  let verdict: EntryVerdict
  if (reference <= stretchEntry) verdict = 'strong_buy'
  else if (reference <= entryPrice) verdict = 'buy'
  else if (reference <= fmv * (1 + requiredDiscount * 0.5)) verdict = 'fair'
  else if (reference <= fmv * (1 + requiredDiscount * 1.5)) verdict = 'rich'
  else verdict = 'overpriced'

  // Never call something a strong buy off evidence that cannot support it.
  if (fmvResult.confidence === 'none') {
    verdict = 'unknown'
  } else if (fmvResult.confidence === 'low' && verdict === 'strong_buy') {
    verdict = 'buy'
    rationale.push('Capped at Buy rather than Strong buy: the FMV behind it is low confidence.')
  }

  rationale.push(
    reference <= entryPrice
      ? `Asking ${money(reference)} is at or below the ${money(entryPrice)} target.`
      // The direction is in the word, so the number stays unsigned.
      : `Asking ${money(reference)} is ${pct(Math.abs((reference - fmv) / fmv)).replace('+', '')} ${reference >= fmv ? 'above' : 'below'} FMV; the target is ${money(entryPrice)}.`,
  )

  return { verdict, score, entryPrice, stretchEntry, requiredDiscount, volatility, momentum90d, rationale }
}

/** Trailing 90-day drift, as a fraction of the mean price over the window. */
function computeMomentum(points: PricePoint[], now = new Date()): number | null {
  const recent = points.filter((p) => daysAgo(p.date, now) <= 90)
  if (recent.length < 3) return null
  const t0 = Date.parse(recent[0].date)
  const xs = recent.map((p) => (Date.parse(p.date) - t0) / 86_400_000)
  const ys = recent.map(effectivePrice)
  const span = xs[xs.length - 1] - xs[0]
  if (span < 14) return null
  const m = mean(ys)
  if (!(m > 0)) return null
  const s = slopeOf(xs, ys)
  return s == null ? null : (s * 90) / m
}

function slopeOf(xs: number[], ys: number[]): number | null {
  const mx = mean(xs)
  const my = mean(ys)
  let num = 0
  let den = 0
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) ** 2
  }
  return den === 0 ? null : num / den
}

/**
 * Run the whole pipeline for one item.
 * `askingPrice` is what the user is being quoted; without one we judge the
 * current market against itself using FMV as the reference.
 */
export function analyzeItem(series: PriceSeries, askingPrice?: number | null, now = new Date()): ItemAnalysis {
  const fmv = computeFmv(series, now)
  const reference = askingPrice ?? null
  const range = compute52WeekRange(series, reference ?? fmv.fmv, now)
  const sixMonthRange = computeRange(series, reference ?? fmv.fmv, now, SIX_MONTH_DAYS)
  const entry = computeEntry(fmv, range, series, reference, now)
  return {
    key: series.key, fmv, range, sixMonthRange, entry, referencePrice: reference,
    lastSale: lastSaleAt(series, now),
    quote: series.quote, quoteExcluded: series.quoteExcluded,
  }
}

/** Assemble one item's series from uploaded history, stored snapshots and a live quote. */
export function buildSeries(
  key: string,
  uploaded: PricePoint[] = [],
  snapshots: PricePoint[] = [],
  quote?: PriceSeries['quote'],
  opts: { graded?: boolean } = {},
): PriceSeries {
  const points: PricePoint[] = [...uploaded, ...snapshots]
  // A TCGplayer-style quote prices a raw card. Feeding it to a graded copy
  // would value a PSA 10 at ungraded money, so for a slab the quote is kept
  // on the series for display and deliberately excluded from the blend.
  if (quote && !opts.graded) {
    const date = quote.updatedAt ? toISODate(quote.updatedAt) : toISODate(new Date())
    if (quote.market != null && quote.market > 0) points.push({ date, price: quote.market, source: 'market' })
    if (quote.directLow != null && quote.directLow > 0) points.push({ date, price: quote.directLow, source: 'sale' })
    if (quote.low != null && quote.high != null && quote.low > 0 && quote.high > 0) {
      points.push({ date, price: (quote.low + quote.high) / 2, source: 'mid' })
    }
  }
  // Collapse exact duplicates that repeated imports would otherwise pile up.
  const seen = new Set<string>()
  const deduped = points.filter((p) => {
    const sig = `${p.date}|${p.price}|${p.source}`
    if (seen.has(sig)) return false
    seen.add(sig)
    return true
  })
  return { key, points: deduped, quote, quoteExcluded: !!quote && !!opts.graded }
}

/** Note appended for a graded item whose only market reference is a raw quote. */
export const GRADED_QUOTE_NOTE =
  'Graded copy: the available market quote prices a raw card, so it is shown for reference but excluded from FMV. Add your own sold comps for a grade-accurate value.'

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

function money(x: number): string {
  return x.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

/** Movement smaller than this is noise in a five-sale sample, not a trend. */
export const TREND_FLAT_BAND = 0.05

export interface TrendResult {
  direction: 'up' | 'down' | 'flat' | 'unknown'
  /** Fitted change across the sampled span, as a fraction of the mean price. */
  changePct: number | null
  /** The same movement expressed per 30 days, so spans compare against each other. */
  perMonthPct: number | null
  sampleSize: number
  spanDays: number | null
  firstDate: string | null
  lastDate: string | null
  /** False when read from recorded prices because there were too few sales. */
  fromSales: boolean
  rationale: string
}

const UNKNOWN_TREND: TrendResult = {
  direction: 'unknown', changePct: null, perMonthPct: null,
  sampleSize: 0, spanDays: null, firstDate: null, lastDate: null, fromSales: false,
  rationale: `Fewer than ${MIN_SALES_FOR_MEDIAN} recent sales, so there is no trend to read.`,
}

/**
 * Which way the last few sales are pointing.
 *
 * Over the same sales the valuation uses, so the two never disagree about what
 * the evidence is. A line is fitted through all of them rather than comparing
 * the first to the last: with five sales a single outlier at either end would
 * otherwise decide the direction on its own.
 *
 * The result is a fraction of the mean price, not of the first sale, so a low
 * opening sale cannot inflate the move.
 */
export function computeTrend(series: PriceSeries, now = new Date()): TrendResult {
  const windowed = pointsInWindow(series.points, now)
  const newestFirst = (ps: PricePoint[]) => [...ps].sort((a, b) => b.date.localeCompare(a.date))

  // Completed sales are the better evidence, but a sheet of recorded prices is
  // still a record of which way something moved — reading direction only from
  // sales would leave an imported price history with nothing to say.
  const sold = newestFirst(windowed.filter((p) => p.source === 'sale'))
  const fromSales = sold.length >= MIN_SALES_FOR_MEDIAN
  const pool = fromSales ? sold : newestFirst(windowed.filter((p) => p.source !== 'listing'))

  const sales = pool.slice(0, SALES_FOR_MEDIAN).sort((a, b) => a.date.localeCompare(b.date))

  if (sales.length < MIN_SALES_FOR_MEDIAN) {
    return { ...UNKNOWN_TREND, sampleSize: sales.length }
  }
  const observed = fromSales ? 'sales' : 'recorded prices'

  const first = sales[0]
  const last = sales[sales.length - 1]
  const xs = sales.map((s) => daysBetween(first.date, s.date))
  const ys = sales.map(effectivePrice)
  const spanDays = xs[xs.length - 1]
  const avg = mean(ys)

  const base = {
    sampleSize: sales.length, spanDays, fromSales,
    firstDate: first.date, lastDate: last.date,
  }

  const m = spanDays > 0 ? slope(xs, ys) : null
  if (m == null || !(avg > 0)) {
    return {
      ...base, direction: 'flat', changePct: 0, perMonthPct: 0,
      rationale: `${sales.length} ${observed} all landed too close together in time to read a direction from.`,
    }
  }

  const changePct = (m * spanDays) / avg
  const perMonthPct = (m * 30) / avg
  const direction = changePct >= TREND_FLAT_BAND ? 'up' : changePct <= -TREND_FLAT_BAND ? 'down' : 'flat'
  const moved = `${changePct >= 0 ? 'up' : 'down'} ${Math.abs(changePct * 100).toFixed(1)}%`

  return {
    ...base,
    direction,
    changePct,
    perMonthPct,
    fromSales,
    rationale: direction === 'flat'
      ? `The last ${sales.length} ${observed} moved ${moved} across ${spanDays} days — inside the ${(TREND_FLAT_BAND * 100).toFixed(0)}% band that counts as flat for a sample this small.`
      : `The last ${sales.length} ${observed} trend ${moved} across ${spanDays} days, about ${Math.abs(perMonthPct * 100).toFixed(1)}% a month.`,
  }
}

/**
 * The most recent completed sale, whatever venue it happened on.
 *
 * Distinct from market value on purpose. Market value is the median of the
 * last few sales, which is deliberately resistant to one unusual result; this
 * is the literal last price the exact card changed hands for.
 *
 * It does not insist on a venue. Insisting on eBay hid real sales twice over:
 * comps fetched before venues were recorded carry none at all, and a card that
 * trades at auction houses would report nothing while plainly having sold. The
 * venue is reported when it is known, so an auction-house result can be
 * recognised as one, rather than used to suppress the number.
 */
export function lastSaleAt(series: PriceSeries, now = new Date()): LastSale | null {
  const sales = pointsInWindow(series.points, now)
    .filter((p) => p.source === 'sale' && p.price > 0)
    .sort((a, b) => b.date.localeCompare(a.date))
  const latest = sales[0]
  if (!latest) return null
  return {
    price: latest.price,
    date: latest.date,
    venue: latest.venue ?? null,
    ageDays: daysAgo(latest.date, now),
  }
}

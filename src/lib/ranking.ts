/**
 * Ordering a watchlist by how interesting each card looks to buy.
 *
 * This is a screen, not a recommendation. It sorts on four things that can be
 * measured from the sales record, shows what each one contributed, and leaves
 * the judgement where it belongs. Nothing here knows about a reprint, a
 * grading population that is about to double, a set rotating into or out of
 * fashion, or the fact that you already own three of them.
 *
 * **Why four and not one.** "Down a lot from its high" was the thing worth
 * ranking on, and on its own it is the oldest trap there is: the cards furthest
 * below their peak are disproportionately the ones that deserve to be. A
 * seventy-per-cent drawdown that is still falling is not a discount, it is a
 * price on its way somewhere lower. So the drawdown is counted, and then
 * checked against whether the thing has stopped falling, whether the sales
 * record actually points upward from here, and whether today's asking price is
 * below what the card is worth. A card scores well only when several of those
 * agree, which is the whole point of not ranking on the drawdown alone.
 *
 * **Every component is bounded.** A card ninety per cent off its high scores
 * the same on that component as one eighty per cent off, because past a point
 * the difference stops being information about value and starts being
 * information about distress. The same applies to expected return: a projected
 * forty per cent a year and a projected four hundred score alike, the second
 * being a symptom of a thin record rather than a better opportunity.
 */
import { robustDrift } from './forecast'
import { daysAgo } from './stats'
import type { ItemAnalysis, PriceSeries, WatchItem } from './types'

/** Drawdown at which the discount component is already full marks. */
const FULL_DRAWDOWN = 0.5

/** Annualized one-year return at which the upside component is full marks. */
const FULL_UPSIDE = 0.25

/** Discount to the entry target at which the value component is full marks. */
const FULL_VALUE = 0.15

/** Annualized recent trend, either way, at which steadiness saturates. */
const FULL_TREND = 0.3

/**
 * How many of the latest sales the recent trend is read from.
 *
 * Counted in sales, not in days, and that is the whole point. Every
 * fixed window fails the same way: ninety days needs three sales in a quarter,
 * nine months needs three in nine, and a card that trades a handful of times a
 * year will have too few in either. It then drops out of the ranking silently
 * — and because the remaining weights renormalize, the card is scored purely
 * on being cheap, with nothing left to ask whether it is cheap for a reason.
 * The guard against a falling knife cannot be the part that goes missing
 * exactly when a card trades thinly.
 *
 * Six sales adapts instead: for a card trading monthly that is half a year,
 * for one trading twice a year it is three. The window is then reported in the
 * wording, because "rising over the last four months" and "rising over the
 * last three years" are not the same claim and should not read alike.
 */
const RECENT_SALES = 6

/** Below this many sales there is no direction to read at all. */
const MIN_SALES_FOR_TREND = 3

/** Log rate below which a card is said to be falling, about -10% a year. */
const FALLING_FAST = -0.1

export interface RecentTrend {
  /** Annualized, in logs. */
  perYear: number
  /** Calendar days the sales it was read from actually cover. */
  spanDays: number
  sampleSize: number
}

/**
 * Which way a card has been going lately, read from its latest sales.
 *
 * The median of every pairwise slope over them: it needs few points, and a
 * third of them have to be wrong before it moves. Sales in the future are
 * ignored, so a sheet with a forward-dated row cannot invent a trend.
 */
export function recentTrend(series: PriceSeries | undefined, now = new Date()): RecentTrend | null {
  if (!series) return null
  const sorted = series.points
    .filter((p) => p.price > 0 && daysAgo(p.date, now) >= 0)
    .sort((a, b) => a.date.localeCompare(b.date))
  const recent = sorted.slice(-RECENT_SALES)
  if (recent.length < MIN_SALES_FOR_TREND) return null
  const perDay = robustDrift(recent)
  if (perDay == null) return null
  return {
    perYear: perDay * 365,
    spanDays: daysAgo(recent[0].date, now) - daysAgo(recent[recent.length - 1].date, now),
    sampleSize: recent.length,
  }
}

/** "four months", "three years" — the window said the way it reads. */
function spanWords(days: number): string {
  if (days < 45) return 'few weeks'
  if (days < 400) return `${Math.max(1, Math.round(days / 30))} months`
  return `${(days / 365).toFixed(1)} years`
}

export interface RankComponent {
  key: 'drawdown' | 'upside' | 'value' | 'steadiness'
  label: string
  /** Zero to one, before weighting. */
  score: number
  weight: number
  /** What the number actually was, said in words. */
  detail: string
}

export type RankVerdict = 'strong' | 'worth a look' | 'thin case' | 'not now' | 'no data'

export interface RankedItem {
  key: string
  item: WatchItem
  analysis?: ItemAnalysis
  /** Zero to one hundred. */
  score: number
  verdict: RankVerdict
  components: RankComponent[]
  /** Why it landed where it did, strongest reason first. */
  reasons: string[]
  /** Said plainly when something about the case is unsound. */
  warnings: string[]
}

const WEIGHTS: Record<RankComponent['key'], number> = {
  drawdown: 0.3,
  upside: 0.3,
  value: 0.25,
  steadiness: 0.15,
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
const pct = (x: number) => `${Math.round(x * 100)}%`

/**
 * A log growth rate, said the way a person would say it.
 *
 * `robustDrift` works in logs, where a rate of 1.25 is a card two and a half
 * times dearer, not one up by 125%. Printing the log rate directly understates
 * every fast mover and does it silently.
 */
const rate = (logRate: number) => `${Math.round(Math.expm1(logRate) * 100)}%`

/**
 * How much calendar a record needs before its maximum counts as an all-time
 * high. A year: less than that and the phrase is claiming more than it knows.
 */
export const DEEP_RECORD_DAYS = 365

/** How far below its all-time high a card currently sits. */
export function drawdownFromHigh(analysis: ItemAnalysis): number | null {
  const high = analysis.allTimeRange.high
  const now = analysis.lastSale?.price ?? analysis.fmv.fmv
  if (high == null || now == null || !(high > 0) || !(now > 0)) return null
  return clamp01(1 - now / high)
}

/**
 * Score one card, or say why it cannot be scored.
 *
 * A card with no usable sales record is never given a low score — it is given
 * none, because a low score and an unknown one would otherwise sort together
 * and the unknown ones would look like rejections.
 */
export function rankItem(
  item: WatchItem,
  key: string,
  analysis?: ItemAnalysis,
  series?: PriceSeries,
  now = new Date(),
): RankedItem {
  const empty: RankedItem = {
    key, item, analysis, score: 0, verdict: 'no data', components: [],
    reasons: [], warnings: ['No usable sales on record, so there is nothing to rank this on.'],
  }
  if (!analysis) return empty

  const current = analysis.lastSale?.price ?? analysis.fmv.fmv
  if (current == null || !(current > 0)) return empty

  const components: RankComponent[] = []
  const warnings: string[] = []

  const drawdown = drawdownFromHigh(analysis)
  if (drawdown != null) {
    components.push({
      key: 'drawdown',
      label: 'Off its high',
      score: clamp01(drawdown / FULL_DRAWDOWN),
      weight: WEIGHTS.drawdown,
      detail: drawdown < 0.02
        ? 'At or near its all-time high'
        : `${pct(drawdown)} below its all-time high`,
    })
  }

  // Expected return over the horizon the forecast is least unreliable at.
  const year = analysis.forecast?.projections.find((p) => p.years === 1)
  if (year) {
    components.push({
      key: 'upside',
      label: 'Expected in a year',
      score: clamp01(year.roiMid / FULL_UPSIDE),
      weight: WEIGHTS.upside,
      detail: `${pct(year.roiMid)} a year at the midpoint, ${pct(year.chanceAboveBasis)} chance of being ahead`,
    })
  }

  // How today's asking price compares with the price the entry model says is
  // worth paying. Only meaningful when there is an asking price to compare.
  const { entryPrice } = analysis.entry
  const asking = analysis.referencePrice
  if (entryPrice != null && entryPrice > 0 && asking != null && asking > 0) {
    const under = (entryPrice - asking) / entryPrice
    components.push({
      key: 'value',
      label: 'Against the entry target',
      score: clamp01(under / FULL_VALUE),
      weight: WEIGHTS.value,
      detail: under >= 0
        ? `Asking ${pct(under)} below the target of ${Math.round(entryPrice)}`
        : `Asking ${pct(-under)} above the target of ${Math.round(entryPrice)}`,
    })
  }

  // The counterweight. A deep drawdown that is still deepening is not a
  // discount, and this is the only component that can take points away from
  // one that looks cheap.
  const trend = recentTrend(series, now)
  if (trend != null) {
    components.push({
      key: 'steadiness',
      label: 'Lately',
      score: clamp01((trend.perYear + FULL_TREND) / (2 * FULL_TREND)),
      weight: WEIGHTS.steadiness,
      detail: `${trend.perYear >= 0 ? 'Rising' : 'Falling'} at ${
        rate(Math.abs(trend.perYear))
      } a year across its last ${trend.sampleSize} sales, spanning ${spanWords(trend.spanDays)}`,
    })
  }

  if (components.length === 0) return empty

  // Weights are renormalized over the components that could be measured, so a
  // card missing one is not quietly punished for the gap.
  const totalWeight = components.reduce((a, c) => a + c.weight, 0)
  const score = Math.round((components.reduce((a, c) => a + c.score * c.weight, 0) / totalWeight) * 100)

  // A card that is falling says so, whether or not it is also far off its high.
  // Tying this to a deep drawdown meant a card sliding hard from near its peak
  // passed without comment while the panel showed the slide two lines above.
  if (trend != null && trend.perYear < FALLING_FAST) {
    warnings.push(
      drawdown != null && drawdown > 0.4
        ? `Well below its high and still falling — ${pct(drawdown)} off the peak, and still going down at ${
          rate(Math.abs(trend.perYear))
        } a year. Cheap because it is dropping is not the same as cheap.`
        : `Falling at ${rate(Math.abs(trend.perYear))} a year across its last ${
          trend.sampleSize
        } sales. Whatever else is in its favour, it is going down as of the latest ones.`,
    )
  }

  // The dangerous gap: cheap, and no way to tell whether it has stopped
  // falling. Said out loud, because otherwise its absence reads as an all-clear
  // and the remaining components quietly count for more.
  if (drawdown != null && drawdown > 0.4 && trend == null) {
    warnings.push(
      `${pct(drawdown)} off its high, and too few sales on record to tell whether it has stopped falling.`,
    )
  }

  // The forecast can point up while the card itself points down, because most
  // of it is the market and this card's own decline is shrunk as too thinly
  // evidenced to carry. That is defensible arithmetic and a terrible thing to
  // leave unsaid beside a positive expected return.
  if (year != null && year.roiMid > 0.02 && trend != null && trend.perYear < FALLING_FAST) {
    warnings.push(
      'The expected return above is mostly the market. This card itself has been falling, and its own '
      + 'decline was treated as too thinly evidenced to carry forward — so the forecast is more '
      + 'optimistic than its own recent sales are.',
    )
  }
  if (analysis.forecast == null) {
    warnings.push('Too few sales to forecast, so the expected-return half of this ranking is missing.')
  } else if (analysis.forecast.shrunk) {
    warnings.push('Its record is thin enough that the forecast leans mostly on its segment rather than on this card.')
  }
  // Drawdown is the heaviest thing in this score, and it is measured against
  // the all-time high — so how far back the record goes decides the number.
  // The graded feed hands back the newest five sales per slab, which on an
  // actively traded card is a few months: a card that peaked eighteen months
  // ago and has halved since reads as sitting at its all-time high and scores
  // zero on the one component that was asked for. Say so, rather than letting
  // a confident number rest on a quarter of history.
  //
  // Measured on the calendar rather than on `coversWindow`: the all-time band
  // asks for a decade, which no record here covers, so that flag would fire on
  // every card and mean nothing. A year of sales is the bar at which "all-time
  // high" stops being a figure of speech.
  const all = analysis.allTimeRange
  if (all.sampleSize > 0 && all.coverageDays < DEEP_RECORD_DAYS) {
    warnings.push(
      `The record only goes back to ${all.oldest} — ${Math.round(all.coverageDays)} days, ${all.sampleSize} sale${all.sampleSize === 1 ? '' : 's'}. The "all-time high" is the high of that, so a peak before it is invisible here and the drawdown may be understated.`,
    )
  } else if (all.sampleSize < 5) {
    warnings.push(`The all-time high rests on ${all.sampleSize} observations, so "all time" is a short time.`)
  }

  const reasons = [...components]
    .sort((a, b) => b.score * b.weight - a.score * a.weight)
    .map((c) => `${c.label}: ${c.detail}`)

  return { key, item, analysis, score, verdict: verdictFor(score, warnings.length), components, reasons, warnings }
}

function verdictFor(score: number, warnings: number): RankVerdict {
  if (score >= 70 && warnings === 0) return 'strong'
  if (score >= 55) return 'worth a look'
  if (score >= 35) return 'thin case'
  return 'not now'
}

/**
 * Rank a whole watchlist, best first.
 *
 * Cards that cannot be scored go last as a group rather than being sorted in
 * among the low scores, since "nothing is known about this" and "this looks
 * poor" are different answers and should not sit next to each other.
 */
export function rankWatchlist(
  items: WatchItem[],
  keyOf: (item: WatchItem) => string,
  analyses: Map<string, ItemAnalysis>,
  seriesByKey?: Map<string, PriceSeries>,
  now = new Date(),
): RankedItem[] {
  return items
    .map((item) => {
      const key = keyOf(item)
      return rankItem(item, key, analyses.get(key), seriesByKey?.get(key), now)
    })
    .sort((a, b) => {
      const known = (r: RankedItem) => (r.verdict === 'no data' ? 1 : 0)
      if (known(a) !== known(b)) return known(a) - known(b)
      return b.score - a.score
    })
}

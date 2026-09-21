/**
 * Whether a card's numbers can be trusted, and what it would take.
 *
 * Two separate failures, and the app said nothing about either.
 *
 * **The record does not reach back a year.** The feed returns only the newest
 * few sales per slab, so a "52-week high" can be the high of six days. The
 * band already reports its own span, but nothing told the owner which cards
 * were affected or how badly — leaving "get history for all 32" as the only
 * visible option when the real answer is usually a much shorter list.
 *
 * **The card trades faster than it is refreshed.** This is the one that does
 * not fix itself. A slab selling five times a week, against a feed that hands
 * back five and a refresh once a month, loses roughly twenty sales a month
 * permanently — and the true yearly high is as likely to be among the lost
 * ones as the kept ones. Backfilling history does nothing for it; only
 * refreshing more often does. A card can therefore be perfectly covered today
 * and drifting out of true from tomorrow.
 */
import { WINDOW_DAYS } from './analytics'
import { daysAgo, daysBetween } from './stats'
import type { ItemAnalysis, PricePoint } from './types'

/**
 * How many sales a single fetch brings back.
 *
 * Measured: `get_cert_values_bulk` returned exactly five for every cert, and
 * `search_by_certs_bulk` ten for one of them. Five is the conservative figure
 * and the one that decides whether sales are being missed.
 */
export const SALES_PER_FETCH = 5

/** Below this share of the window, the band is not of the window. */
export const COVERAGE_FLOOR = 0.75

export type GapKind = 'shallow' | 'outpaced' | 'both' | 'none'

export interface HistoryGap {
  key: string
  name: string
  /** Days from the oldest sale held to today. */
  reachDays: number
  sampleSize: number
  /** Sales a day, from the cadence of what is held. Null when unmeasurable. */
  tradesPerDay: number | null
  /**
   * How long a refresh can wait before sales start being lost, at that
   * cadence. Null when the cadence could not be measured.
   */
  safeRefreshDays: number | null
  /** Days since prices were last fetched, if ever. */
  sinceFetchDays: number | null
  /** Sales likely lost since the last fetch, at that cadence. 0 when none. */
  likelyMissed: number
  kind: GapKind
  /**
   * Why the one-call history fix cannot run for this card, or null when it
   * can. A thin card that silently spends nothing is the worst outcome: the
   * button reports two credits, nothing changes, and there is no way to learn
   * why without reading the source.
   */
  blocked: 'no-card-id' | 'already-fetched' | 'endpoint-refused' | null
  /** 0-1. Higher means the card's numbers are further from trustworthy. */
  severity: number
  /** One sentence, for a person deciding where to spend their evening. */
  reason: string
}

/** Sales only: a typed figure says nothing about how fast a card trades. */
function tradesOf(points: PricePoint[]): PricePoint[] {
  return points.filter((p) => p.source === 'sale').sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * How often the card changes hands, from the sales held.
 *
 * Deliberately measured over the fetched window rather than the whole record:
 * the question is what the card is doing *now*, and a backfilled year of quiet
 * trading would hide a slab that has started selling weekly.
 */
export function tradeRate(points: PricePoint[]): number | null {
  const trades = tradesOf(points)
  if (trades.length < 2) return null
  // One fetch-load of sales, no more. Taking a wider slice let a backfilled
  // year of quiet trading average away a slab that has started selling daily
  // — which is precisely the card this is for, and the reason the window is
  // the same size as the thing it is testing: "at this rate, does one fetch
  // still keep up?"
  const recent = trades.slice(-SALES_PER_FETCH)
  const span = daysBetween(recent[0].date, recent[recent.length - 1].date)
  // Several sales on one day is a real cadence, not a divide-by-zero: count
  // them against a single day rather than refusing to measure.
  return (recent.length - 1) / Math.max(span, 1)
}

export function assessHistory(
  key: string,
  name: string,
  points: PricePoint[],
  analysis: ItemAnalysis | undefined,
  lastFetched: string | null,
  now = new Date(),
  backfill: { cardId?: string; fetched?: { unavailable: boolean } } = {},
): HistoryGap {
  const trades = tradesOf(points)
  const reachDays = trades.length > 0 ? daysAgo(trades[0].date, now) : 0
  const covered = reachDays >= WINDOW_DAYS * COVERAGE_FLOOR
  const rate = tradeRate(points)
  const safeRefreshDays = rate && rate > 0 ? SALES_PER_FETCH / rate : null
  const sinceFetchDays = lastFetched ? daysAgo(lastFetched, now) : null

  // Sales lost is what the card produced beyond what one fetch can carry.
  const likelyMissed = rate != null && sinceFetchDays != null
    ? Math.max(0, Math.round(rate * sinceFetchDays) - SALES_PER_FETCH)
    : 0

  const shallow = !covered && trades.length > 0
  const outpaced = safeRefreshDays != null && safeRefreshDays < 30

  const kind: GapKind = shallow && outpaced ? 'both' : shallow ? 'shallow' : outpaced ? 'outpaced' : 'none'

  // Depth counts for more than cadence: a band over six days is wrong now,
  // where an outpaced card is merely going to drift if left alone.
  const depthMiss = covered ? 0 : 1 - reachDays / (WINDOW_DAYS * COVERAGE_FLOOR)
  const paceMiss = safeRefreshDays == null ? 0 : Math.max(0, 1 - safeRefreshDays / 30)
  const severity = Math.min(1, depthMiss * 0.7 + paceMiss * 0.3)

  const blocked: HistoryGap['blocked'] = !shallow
    ? null
    : backfill.fetched?.unavailable
      ? 'endpoint-refused'
      : backfill.fetched
        ? 'already-fetched'
        : backfill.cardId
          ? null
          : 'no-card-id'

  return {
    key, name, reachDays, sampleSize: trades.length, tradesPerDay: rate,
    safeRefreshDays, sinceFetchDays, likelyMissed, kind, severity, blocked,
    reason: wordFor(kind, reachDays, trades.length, safeRefreshDays, likelyMissed, analysis)
      + blockedWord(blocked),
  }
}

/** Said out loud, because a silent skip is indistinguishable from a bug. */
function blockedWord(blocked: HistoryGap['blocked']): string {
  switch (blocked) {
    case 'no-card-id':
      return ' Its full history cannot be fetched: Card Ladder returned no card id for this'
        + ' certificate, only an internal hash, which the sales endpoint rejects. That is why'
        + ' pressing the button spends nothing on it.'
    case 'already-fetched':
      return ' Its full history has already been fetched — this is everything Card Ladder holds.'
    case 'endpoint-refused':
      return ' The full-history endpoint refused for this card, so it is not asked again.'
    default:
      return ''
  }
}

function wordFor(
  kind: GapKind, reachDays: number, sampleSize: number,
  safeRefreshDays: number | null, likelyMissed: number, analysis: ItemAnalysis | undefined,
): string {
  const every = safeRefreshDays == null ? null
    : safeRefreshDays < 1.5 ? 'every day'
    : safeRefreshDays < 10 ? `every ${Math.round(safeRefreshDays)} days`
    : `every ${Math.round(safeRefreshDays / 7)} weeks`

  if (sampleSize === 0) return 'No completed sales fetched yet, so there is nothing to read a high or low from.'

  const depth = `Its ${sampleSize} sale${sampleSize === 1 ? '' : 's'} reach back ${Math.round(reachDays)} days, so the "yearly" high is the high of ${Math.round(reachDays)}.`
  // The drawdown carries the most weight in a buy score and is measured
  // against the peak, so a record that starts after the peak scores the card
  // as sitting at its high.
  const ranks = analysis && analysis.allTimeRange.sampleSize > 0
    ? ' Its buy ranking rests on that, so a peak before it is invisible.' : ''
  const pace = likelyMissed > 0
    ? `Trading fast enough to have lost about ${likelyMissed} sale${likelyMissed === 1 ? '' : 's'} since the last fetch — refresh ${every} to stop losing more.`
    : `Trades fast enough that a fetch only holds ${SALES_PER_FETCH} of them: refresh ${every} or sales start being lost for good.`

  if (kind === 'both') return `${depth}${ranks} ${pace}`
  if (kind === 'shallow') return `${depth}${ranks}`
  if (kind === 'outpaced') return pace
  return 'Enough history, and refreshed often enough to keep it.'
}

/** The cards worth doing something about, worst first. */
export function rankGaps(gaps: HistoryGap[]): HistoryGap[] {
  return gaps.filter((g) => g.kind !== 'none').sort((a, b) => b.severity - a.severity)
}

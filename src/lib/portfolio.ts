/** Portfolio-level aggregation across the four segments. */
import { analyzeItem, pointsInWindow } from './analytics'
import { itemKey } from './key'
import { toISODate } from './stats'
import { SEGMENTS } from './types'
import type {
  Holding, ItemAnalysis, PortfolioStats, PriceSeries, Segment, SegmentStats, ValueSnapshot,
} from './types'

export function holdingKey(h: Pick<Holding, 'name' | 'set' | 'number' | 'grader' | 'grade'>): string {
  return itemKey(h)
}

/**
 * Per-unit value. A holding with no observation anywhere is left unvalued
 * rather than falling back to cost basis, which would invent a 0% return.
 */
/**
 * What one of these is worth, for the purpose of gain.
 *
 * The last price it actually changed hands for. A median of recent comps is
 * the steadier estimate and is shown per card, but unrealized gain is the
 * difference between what was paid and what the thing goes for — so it is
 * measured against a real transaction, not an average of several.
 *
 * Portfolio value, unrealized and return all run through here, so the totals
 * and the per-position figures agree. Where nothing has sold inside the window
 * the median stands in rather than leaving the position unvalued.
 */
export function unitValue(analysis?: ItemAnalysis): number | null {
  return analysis?.lastSale?.price ?? analysis?.fmv.fmv ?? null
}

export function analyzeHoldings(
  holdings: Holding[],
  seriesByKey: Map<string, PriceSeries>,
  now = new Date(),
): Map<string, ItemAnalysis> {
  const out = new Map<string, ItemAnalysis>()
  for (const h of holdings) {
    const key = holdingKey(h)
    if (out.has(key)) continue
    const series = seriesByKey.get(key) ?? { key, points: [] }
    out.set(key, analyzeItem(series, null, now))
  }
  return out
}

export function computePortfolioStats(
  holdings: Holding[],
  analyses: Map<string, ItemAnalysis>,
): PortfolioStats {
  const bySegment = new Map<Segment, SegmentStats>()
  for (const s of SEGMENTS) {
    bySegment.set(s, {
      segment: s, items: 0, units: 0, marketValue: 0, costBasis: 0,
      valuedCostBasis: 0, unrealized: 0, roi: null, weight: 0,
    })
  }

  let marketValue = 0
  let costBasis = 0
  let valuedCostBasis = 0
  let units = 0
  let unvalued = 0
  const positionValues: { name: string; value: number }[] = []

  for (const h of holdings) {
    const seg = bySegment.get(h.segment)!
    const uv = unitValue(analyses.get(holdingKey(h)))
    const positionCost = h.costBasis * h.quantity
    const positionValue = uv != null ? uv * h.quantity : null

    seg.items += 1
    seg.units += h.quantity
    seg.costBasis += positionCost
    costBasis += positionCost
    units += h.quantity

    if (positionValue == null) {
      unvalued += 1
    } else {
      seg.marketValue += positionValue
      seg.valuedCostBasis += positionCost
      marketValue += positionValue
      valuedCostBasis += positionCost
      positionValues.push({ name: h.name, value: positionValue })
    }
  }

  for (const seg of bySegment.values()) {
    seg.unrealized = seg.marketValue - seg.valuedCostBasis
    seg.roi = seg.valuedCostBasis > 0 ? seg.unrealized / seg.valuedCostBasis : null
    seg.weight = marketValue > 0 ? seg.marketValue / marketValue : 0
  }

  // Herfindahl index: the sum of squared position weights. 1.0 is a single position.
  const concentration = marketValue > 0
    ? positionValues.reduce((a, p) => a + (p.value / marketValue) ** 2, 0)
    : 0
  const top = positionValues.sort((a, b) => b.value - a.value)[0] ?? null

  return {
    marketValue,
    costBasis,
    valuedCostBasis,
    unrealized: marketValue - valuedCostBasis,
    roi: valuedCostBasis > 0 ? (marketValue - valuedCostBasis) / valuedCostBasis : null,
    items: holdings.length,
    units,
    segments: SEGMENTS.map((s) => bySegment.get(s)!),
    concentration,
    topPosition: top ? { name: top.name, value: top.value, weight: top.value / marketValue } : null,
    unvalued,
  }
}

/**
 * Reconstruct portfolio value over time from observed prices.
 *
 * Constituents are held constant: before a position's first observation its
 * earliest known price is carried backwards, and after its last observation
 * that price is carried forward. That keeps the line measuring price movement
 * rather than the growth of our own data coverage - which is what a naive
 * "only count what we have" reconstruction actually plots.
 */
export function buildValueTrend(
  holdings: Holding[],
  seriesByKey: Map<string, PriceSeries>,
  days = 365,
  now = new Date(),
): ValueSnapshot[] {
  const sampleDates: string[] = []
  const stepDays = days > 180 ? 7 : 1
  for (let d = days; d >= 0; d -= stepDays) {
    sampleDates.push(toISODate(new Date(now.getTime() - d * 86_400_000)))
  }

  // Pre-sort each position's usable points once.
  const prepared = holdings.map((h) => {
    const series = seriesByKey.get(holdingKey(h))
    const pts = series ? pointsInWindow(series.points, now, days + 1) : []
    return { holding: h, points: pts }
  })
  if (prepared.every((p) => p.points.length === 0)) return []

  const costBasis = holdings.reduce((a, h) => a + h.costBasis * h.quantity, 0)

  return sampleDates.map((date) => {
    const bySegment: Partial<Record<Segment, number>> = {}
    let marketValue = 0
    for (const { holding, points } of prepared) {
      if (points.length === 0) continue
      let price = points[0].price // back-fill before the first observation
      for (const p of points) {
        if (p.date <= date) price = p.price
        else break
      }
      const v = price * holding.quantity
      marketValue += v
      bySegment[holding.segment] = (bySegment[holding.segment] ?? 0) + v
    }
    return { date, marketValue, costBasis, bySegment }
  })
}

import { describe, expect, it } from 'vitest'
import { analyzeHoldings, buildValueTrend, computePortfolioStats, holdingKey } from './portfolio'
import type { Holding, PricePoint, PriceSeries, Segment } from './types'

const NOW = new Date('2026-09-18T00:00:00Z')
const daysBack = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10)

function holding(partial: Partial<Holding> & { name: string; segment: Segment }): Holding {
  return {
    id: partial.name, quantity: 1, costBasis: 0, segmentReason: 'test',
    segmentOverride: null, ...partial,
  }
}

function seriesFor(h: Holding, points: PricePoint[]): [string, PriceSeries] {
  const key = holdingKey(h)
  return [key, { key, points }]
}

describe('computePortfolioStats', () => {
  const sealed = holding({ name: 'Booster Box', segment: 'sealed', quantity: 4, costBasis: 100 })
  const vintage = holding({ name: 'Charizard', segment: 'vintage', quantity: 1, costBasis: 4000 })
  const unpriced = holding({ name: 'Mystery Lot', segment: 'modern', quantity: 1, costBasis: 50 })

  const series = new Map([
    seriesFor(sealed, [{ date: daysBack(1), price: 150, source: 'market' }]),
    seriesFor(vintage, [{ date: daysBack(1), price: 5000, source: 'market' }]),
    seriesFor(unpriced, []),
  ])

  const holdings = [sealed, vintage, unpriced]
  const analyses = analyzeHoldings(holdings, series, NOW)
  const stats = computePortfolioStats(holdings, analyses)

  it('totals value and cost across the book', () => {
    expect(stats.marketValue).toBeCloseTo(4 * 150 + 5000, 2)
    expect(stats.costBasis).toBeCloseTo(4 * 100 + 4000 + 50, 2)
    expect(stats.units).toBe(6)
  })

  it('leaves an unpriced position out of value but keeps its cost', () => {
    expect(stats.unvalued).toBe(1)
    const modern = stats.segments.find((s) => s.segment === 'modern')!
    expect(modern.marketValue).toBe(0)
    expect(modern.costBasis).toBe(50)
  })

  it('reports every segment, including empty ones', () => {
    expect(stats.segments.map((s) => s.segment)).toEqual(['sealed', 'vintage', 'mid', 'modern', 'pikachu_promo'])
    expect(stats.segments.find((s) => s.segment === 'pikachu_promo')!.items).toBe(0)
  })

  it('computes per-segment return against cost', () => {
    const sealedStats = stats.segments.find((s) => s.segment === 'sealed')!
    expect(sealedStats.marketValue).toBe(600)
    expect(sealedStats.roi).toBeCloseTo(0.5, 5)
  })

  it('has segment weights that sum to one', () => {
    const total = stats.segments.reduce((a, s) => a + s.weight, 0)
    expect(total).toBeCloseTo(1, 6)
  })

  it('identifies the largest position and measures concentration', () => {
    expect(stats.topPosition?.name).toBe('Charizard')
    expect(stats.concentration).toBeGreaterThan(0.5)
    expect(stats.concentration).toBeLessThanOrEqual(1)
  })

  it('measures return only over positions it could value', () => {
    // The unpriced $50 position must not drag the return down: it contributed
    // no market value, so counting its cost as a loss invents one.
    const valuedCost = 4 * 100 + 4000
    expect(stats.valuedCostBasis).toBeCloseTo(valuedCost, 2)
    expect(stats.unrealized).toBeCloseTo(stats.marketValue - valuedCost, 2)
    expect(stats.roi).toBeCloseTo((stats.marketValue - valuedCost) / valuedCost, 6)
    expect(stats.roi!).toBeGreaterThan(0)
  })

  it('still reports the full cost basis, including unvalued positions', () => {
    expect(stats.costBasis).toBeGreaterThan(stats.valuedCostBasis)
  })

  it('reports no return at all when nothing could be valued', () => {
    // Previously this produced a -100% loss on a portfolio that had simply
    // never had its prices fetched.
    const items = [
      holding({ name: 'Charizard', segment: 'vintage', costBasis: 4200 }),
      holding({ name: 'Booster Box', segment: 'sealed', costBasis: 118, quantity: 6 }),
    ]
    const s = computePortfolioStats(items, analyzeHoldings(items, new Map(), NOW))
    expect(s.marketValue).toBe(0)
    expect(s.roi).toBeNull()
    expect(s.unrealized).toBe(0)
    expect(s.costBasis).toBeCloseTo(4200 + 6 * 118, 2)
    expect(s.unvalued).toBe(2)
    for (const seg of s.segments) expect(seg.roi).toBeNull()
  })

  it('reports no return when there is no cost basis to measure against', () => {
    const free = holding({ name: 'Gift', segment: 'modern', costBasis: 0 })
    const s = computePortfolioStats([free], analyzeHoldings([free], new Map(), NOW))
    expect(s.roi).toBeNull()
  })
})

describe('buildValueTrend', () => {
  const h = holding({ name: 'Charizard', segment: 'vintage', quantity: 2, costBasis: 1000 })

  it('returns nothing when no position has any price', () => {
    expect(buildValueTrend([h], new Map(), 365, NOW)).toHaveLength(0)
  })

  it('tracks observed prices and multiplies by quantity', () => {
    const series = new Map([seriesFor(h, [
      { date: daysBack(300), price: 100, source: 'sale' },
      { date: daysBack(10), price: 200, source: 'sale' },
    ])])
    const trend = buildValueTrend([h], series, 365, NOW)
    expect(trend.at(-1)!.marketValue).toBe(400)
    expect(trend.at(0)!.marketValue).toBe(200)
  })

  it('holds a position flat before its first observation rather than dropping it', () => {
    // Otherwise the line would plot our growing data coverage as portfolio growth.
    const series = new Map([seriesFor(h, [{ date: daysBack(5), price: 300, source: 'sale' }])])
    const trend = buildValueTrend([h], series, 365, NOW)
    expect(trend.every((t) => t.marketValue === 600)).toBe(true)
  })

  it('splits value across segments at every sample', () => {
    const other = holding({ name: 'Booster Box', segment: 'sealed', quantity: 1, costBasis: 100 })
    const series = new Map([
      seriesFor(h, [{ date: daysBack(5), price: 300, source: 'sale' }]),
      seriesFor(other, [{ date: daysBack(5), price: 150, source: 'sale' }]),
    ])
    const last = buildValueTrend([h, other], series, 365, NOW).at(-1)!
    expect(last.bySegment.vintage).toBe(600)
    expect(last.bySegment.sealed).toBe(150)
    expect(last.marketValue).toBe(750)
  })

  it('carries the cost basis through for the baseline rule', () => {
    const series = new Map([seriesFor(h, [{ date: daysBack(5), price: 300, source: 'sale' }])])
    expect(buildValueTrend([h], series, 365, NOW)[0].costBasis).toBe(2000)
  })
})

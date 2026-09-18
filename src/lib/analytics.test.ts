import { describe, expect, it } from 'vitest'
import {
  LISTING_HAIRCUT, analyzeItem, buildSeries, compute52WeekRange, computeEntry, computeFmv,
} from './analytics'
import type { PricePoint, PriceSeries } from './types'

const NOW = new Date('2026-09-18T00:00:00Z')

function daysBack(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10)
}

function series(points: PricePoint[]): PriceSeries {
  return { key: 'test', points }
}

/** A steady series: a year of monthly sales all around `price`. */
function steady(price: number, months = 12, jitter = 0): PricePoint[] {
  return Array.from({ length: months }, (_, i) => ({
    date: daysBack(i * 30),
    price: price + (i % 2 === 0 ? jitter : -jitter),
    source: 'sale' as const,
  }))
}

describe('computeFmv', () => {
  it('reports nothing rather than guessing when there is no data', () => {
    const r = computeFmv(series([]), NOW)
    expect(r.fmv).toBeNull()
    expect(r.confidence).toBe('none')
  })

  it('lands on the level of a steady series', () => {
    const r = computeFmv(series(steady(100, 12, 3)), NOW)
    expect(r.fmv).toBeGreaterThan(95)
    expect(r.fmv).toBeLessThan(105)
    expect(r.confidence).toBe('high')
  })

  it('weights recent observations far above old ones', () => {
    const r = computeFmv(series([
      { date: daysBack(0), price: 200, source: 'sale' },
      { date: daysBack(300), price: 100, source: 'sale' },
    ]), NOW)
    // A 45-day half-life makes the 300-day-old point nearly weightless.
    expect(r.fmv).toBeGreaterThan(190)
  })

  it('ignores observations older than the one-year window', () => {
    const r = computeFmv(series([
      { date: daysBack(10), price: 100, source: 'sale' },
      { date: daysBack(400), price: 9999, source: 'sale' },
    ]), NOW)
    expect(r.fmv).toBeCloseTo(100, 0)
    expect(r.sampleSize).toBe(1)
  })

  it('cuts active asks before blending them', () => {
    const r = computeFmv(series([{ date: daysBack(0), price: 100, source: 'listing' }]), NOW)
    expect(r.fmv).toBeCloseTo(100 * LISTING_HAIRCUT, 5)
    expect(r.rationale.join(' ')).toMatch(/asks were cut/i)
  })

  it('throws out a wild outlier once the sample supports doing so', () => {
    const points = steady(100, 12, 2)
    points.push({ date: daysBack(5), price: 100_000, source: 'sale' })
    const r = computeFmv(series(points), NOW)
    expect(r.fmv).toBeLessThan(150)
    expect(r.rationale.join(' ')).toMatch(/outlier/i)
  })

  it('keeps every point when the sample is too small to spot an outlier', () => {
    const r = computeFmv(series([
      { date: daysBack(1), price: 100, source: 'sale' },
      { date: daysBack(2), price: 900, source: 'sale' },
    ]), NOW)
    expect(r.sampleSize).toBe(2)
    expect(r.rationale.join(' ')).not.toMatch(/outlier/i)
  })

  it('drops confidence when the inputs disagree', () => {
    const r = computeFmv(series([
      { date: daysBack(1), price: 50, source: 'sale' },
      { date: daysBack(2), price: 400, source: 'sale' },
      { date: daysBack(3), price: 120, source: 'sale' },
      { date: daysBack(4), price: 800, source: 'sale' },
    ]), NOW)
    expect(r.agreement).toBeLessThan(0.45)
    expect(r.confidence).toBe('low')
  })

  it('will not call a stale estimate high confidence', () => {
    const old = steady(100, 12, 2).map((p) => ({ ...p, date: daysBack(120 + Number(p.date.slice(-2))) }))
    expect(computeFmv(series(old), NOW).confidence).not.toBe('high')
  })
})

describe('buildSeries', () => {
  const quote = { market: 100, low: 80, high: 140, directLow: 95, currency: 'USD', provider: 'test', updatedAt: daysBack(0) }

  it('turns a raw-card quote into points for an ungraded item', () => {
    const s = buildSeries('k', [], [], quote)
    expect(s.points.map((p) => p.source).sort()).toEqual(['market', 'mid', 'sale'])
  })

  it('never values a graded slab off a raw-card quote', () => {
    const s = buildSeries('k', [], [], quote, { graded: true })
    expect(s.points).toHaveLength(0)
    // The quote is still carried, for display as context.
    expect(s.quote).toBe(quote)
    expect(computeFmv(s, NOW).fmv).toBeNull()
  })

  it('collapses duplicates from repeated imports', () => {
    const p: PricePoint[] = [{ date: daysBack(1), price: 10, source: 'sale' }]
    expect(buildSeries('k', [...p, ...p], p).points).toHaveLength(1)
  })
})

describe('compute52WeekRange', () => {
  it('measures the band across a full year of data', () => {
    const points = steady(100, 12, 0).map((p, i) => ({ ...p, price: 100 + i * 5 }))
    const r = compute52WeekRange(series(points), 120, NOW)
    expect(r.high).toBe(155)
    expect(r.low).toBe(100)
    expect(r.estimated).toBe(false)
    expect(r.confidence).toBe('medium')
  })

  it('flags a band built on thin history as estimated', () => {
    const r = compute52WeekRange(series([
      { date: daysBack(1), price: 100, source: 'sale' },
      { date: daysBack(3), price: 130, source: 'sale' },
    ]), 110, NOW)
    expect(r.estimated).toBe(true)
    expect(r.confidence).toBe('low')
    expect(r.high).toBe(130)
  })

  it('places the reference price inside the band', () => {
    const points = [
      { date: daysBack(200), price: 100, source: 'sale' as const },
      { date: daysBack(10), price: 200, source: 'sale' as const },
    ]
    expect(compute52WeekRange(series(points), 150, NOW).position).toBeCloseTo(0.5, 2)
    expect(compute52WeekRange(series(points), 200, NOW).position).toBeCloseTo(1, 2)
  })
})

describe('computeEntry', () => {
  function entryFor(points: PricePoint[], asking: number | null) {
    const s = series(points)
    const fmv = computeFmv(s, NOW)
    const range = compute52WeekRange(s, asking ?? fmv.fmv, NOW)
    return { entry: computeEntry(fmv, range, s, asking, NOW), fmv }
  }

  it('demands a bigger discount from a more volatile asset', () => {
    const calm = entryFor(steady(100, 12, 1), 100).entry
    const wild = entryFor(
      Array.from({ length: 12 }, (_, i) => ({ date: daysBack(i * 30), price: i % 2 ? 40 : 190, source: 'sale' as const })),
      100,
    ).entry
    expect(wild.requiredDiscount).toBeGreaterThan(calm.requiredDiscount)
  })

  it('keeps the required discount inside its bounds', () => {
    for (const p of [steady(100, 12, 0), steady(100, 12, 40)]) {
      const d = entryFor(p, 100).entry.requiredDiscount
      expect(d).toBeGreaterThanOrEqual(0.06)
      expect(d).toBeLessThanOrEqual(0.3)
    }
  })

  it('calls a deep discount a strong buy and a premium overpriced', () => {
    const points = steady(100, 12, 3)
    expect(entryFor(points, 55).entry.verdict).toBe('strong_buy')
    expect(entryFor(points, 100).entry.verdict).toBe('fair')
    expect(entryFor(points, 300).entry.verdict).toBe('overpriced')
  })

  it('scores a cheaper ask higher than a dearer one', () => {
    const points = steady(100, 12, 3)
    expect(entryFor(points, 70).entry.score).toBeGreaterThan(entryFor(points, 130).entry.score)
  })

  it('puts the stretch bid below the standard entry', () => {
    const e = entryFor(steady(100, 12, 3), 100).entry
    expect(e.stretchEntry!).toBeLessThanOrEqual(e.entryPrice!)
  })

  it('never escalates to strong buy on low-confidence evidence', () => {
    // A single observation: enough for an FMV, nowhere near enough for conviction.
    const { entry, fmv } = entryFor([{ date: daysBack(1), price: 100, source: 'user' }], 10)
    expect(fmv.confidence).toBe('low')
    expect(entry.verdict).toBe('buy')
    expect(entry.rationale.join(' ')).toMatch(/Capped at Buy/i)
  })

  it('declines to judge without an asking price, but still publishes a target', () => {
    const e = entryFor(steady(100, 12, 3), null).entry
    expect(e.verdict).toBe('unknown')
    expect(e.entryPrice).toBeGreaterThan(0)
  })

  it('declines to judge when there is no data at all', () => {
    const e = entryFor([], 100).entry
    expect(e.verdict).toBe('unknown')
    expect(e.entryPrice).toBeNull()
  })

  it('notices a sustained downtrend', () => {
    const falling = Array.from({ length: 8 }, (_, i) => ({
      date: daysBack(80 - i * 10), price: 200 - i * 12, source: 'sale' as const,
    }))
    const e = entryFor(falling, 100).entry
    expect(e.momentum90d).toBeLessThan(0)
    expect(e.rationale.join(' ')).toMatch(/Down .* over 90 days/i)
  })
})

describe('analyzeItem', () => {
  it('produces the full picture in one pass', () => {
    const a = analyzeItem(series(steady(100, 12, 4)), 72, NOW)
    expect(a.fmv.fmv).toBeGreaterThan(90)
    expect(a.range.high).toBeGreaterThan(a.range.low!)
    expect(['strong_buy', 'buy']).toContain(a.entry.verdict)
    expect(a.referencePrice).toBe(72)
  })
})

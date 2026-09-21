import { describe, expect, it } from 'vitest'
import {
  LISTING_HAIRCUT, SIX_MONTH_DAYS, TREND_FLAT_BAND, analyzeItem, buildSeries, compute52WeekRange,
  computeEntry, computeFmv, computeRange, computeTrend, gradedPricingNote, lastSaleAt,
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

  it('is unmoved by a wild outlier, because a median ignores it', () => {
    const points = steady(100, 12, 2)
    points.push({ date: daysBack(5), price: 100_000, source: 'sale' })
    expect(computeFmv(series(points), NOW).fmv).toBeLessThan(150)
  })

  it('discards outliers on the blend path, which has no median to protect it', () => {
    // Non-sale sources, so the median path does not apply.
    const points: PricePoint[] = Array.from({ length: 12 }, (_, i) => ({
      date: daysBack(i * 30), price: 100, source: 'user' as const,
    }))
    points.push({ date: daysBack(5), price: 100_000, source: 'user' })
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

  it('drops confidence when the sales disagree', () => {
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

describe('how the entry call reads', () => {
  it('states the gap to FMV without a double negative', () => {
    // Three sales is below what the traded band needs, so this is the
    // fair-value branch, which is the one that phrases a gap to FMV at all.
    const s = series(steady(100, 3, 30))
    const fmv = computeFmv(s, NOW)
    const asking = 97
    const range = compute52WeekRange(s, asking, NOW)
    const entry = computeEntry(fmv, range, s, asking, NOW)
    expect(entry.anchoredOnTrades).toBe(false)
    const text = entry.rationale.join(' ')
    expect(text).toMatch(/below FMV/)
    expect(text).not.toMatch(/-\d+\.\d+% below/)
  })

  it('talks about the traded band once there are trades to talk about', () => {
    const s = series(steady(100, 12, 3))
    const fmv = computeFmv(s, NOW)
    const range = compute52WeekRange(s, 97, NOW)
    const entry = computeEntry(fmv, range, s, 97, NOW)
    expect(entry.anchoredOnTrades).toBe(true)
    const text = entry.rationale.join(' ')
    expect(text).toMatch(/Sales this year ran/)
    expect(text).toMatch(/off the high/)
  })
})

describe('why an item has no value', () => {
  const series = (points: { date: string; price: number; source?: 'sale' | 'snapshot' }[], graded = false) => ({
    key: 'k',
    points: points.map((p) => ({ ...p, source: p.source ?? ('sale' as const) })),
    quoteExcluded: graded,
  })
  const NOW = new Date('2026-09-19T00:00:00Z')

  it('says nothing was found when nothing was found', () => {
    const r = computeFmv(series([]), NOW)
    expect(r.fmv).toBeNull()
    expect(r.rationale.join(' ')).toMatch(/no sales on record/i)
  })

  it('points a graded card at its sold comps rather than a price refresh', () => {
    expect(computeFmv(series([], true), NOW).rationale.join(' ')).toMatch(/certificate/i)
  })

  it('distinguishes sales that exist but are all too old', () => {
    // The blank cell used to look identical to having found nothing at all.
    const r = computeFmv(series([
      { date: '2024-01-10', price: 19000 },
      { date: '2024-03-02', price: 21000 },
    ]), NOW)
    expect(r.fmv).toBeNull()
    const said = r.rationale.join(' ')
    expect(said).toMatch(/2 sales on record/i)
    expect(said).toMatch(/2024-03-02/)
    expect(said).toMatch(/last 365 days/i)
    // And it still says what the card last went for.
    expect(said).toMatch(/\$21,000/)
    expect(r.stalenessDays).toBeGreaterThan(365)
  })
})

describe('trend from the last five sales', () => {
  const NOW = new Date('2026-09-19T00:00:00Z')
  const from = (pairs: [string, number][]) => ({
    key: 'k',
    points: pairs.map(([date, price]) => ({ date, price, source: 'sale' as const })),
  })

  it('calls a steady climb up', () => {
    const t = computeTrend(from([
      ['2026-05-01', 1000], ['2026-06-01', 1100], ['2026-07-01', 1200],
      ['2026-08-01', 1300], ['2026-09-01', 1400],
    ]), NOW)
    expect(t.direction).toBe('up')
    expect(t.changePct).toBeGreaterThan(0.3)
    expect(t.sampleSize).toBe(5)
  })

  it('calls a steady slide down', () => {
    const t = computeTrend(from([
      ['2026-05-01', 1400], ['2026-06-01', 1300], ['2026-07-01', 1200],
      ['2026-08-01', 1100], ['2026-09-01', 1000],
    ]), NOW)
    expect(t.direction).toBe('down')
    expect(t.changePct).toBeLessThan(-0.3)
  })

  it('calls small movement flat rather than a trend', () => {
    const t = computeTrend(from([
      ['2026-05-01', 1000], ['2026-06-01', 1010], ['2026-07-01', 995],
      ['2026-08-01', 1005], ['2026-09-01', 1015],
    ]), NOW)
    expect(t.direction).toBe('flat')
    expect(Math.abs(t.changePct!)).toBeLessThan(TREND_FLAT_BAND)
  })

  it('is not decided by a single outlier at one end', () => {
    // First-to-last would read this as a collapse; four of the five sales are flat.
    const t = computeTrend(from([
      ['2026-05-01', 1000], ['2026-06-01', 1000], ['2026-07-01', 1000],
      ['2026-08-01', 1000], ['2026-09-01', 700],
    ]), NOW)
    expect(t.changePct!).toBeGreaterThan(-0.3)
  })

  it('reads only the most recent five, like the valuation does', () => {
    const t = computeTrend(from([
      ['2026-01-01', 100], ['2026-02-01', 200], ['2026-05-01', 1000],
      ['2026-06-01', 1000], ['2026-07-01', 1000], ['2026-08-01', 1000], ['2026-09-01', 1000],
    ]), NOW)
    expect(t.sampleSize).toBe(5)
    expect(t.direction).toBe('flat')
  })

  it('says nothing rather than guessing from two sales', () => {
    const t = computeTrend(from([['2026-08-01', 1000], ['2026-09-01', 2000]]), NOW)
    expect(t.direction).toBe('unknown')
    expect(t.changePct).toBeNull()
  })

  it('ignores sales older than the valuation window', () => {
    const t = computeTrend(from([
      ['2023-01-01', 100], ['2023-02-01', 200], ['2023-03-01', 300],
    ]), NOW)
    expect(t.direction).toBe('unknown')
  })

  it('does not divide by zero when every sale landed the same day', () => {
    const t = computeTrend(from([
      ['2026-09-01', 1000], ['2026-09-01', 1100], ['2026-09-01', 900],
    ]), NOW)
    expect(t.direction).toBe('flat')
    expect(Number.isFinite(t.changePct!)).toBe(true)
  })

  it('expresses the move per month so different spans compare', () => {
    const fast = computeTrend(from([
      ['2026-09-01', 1000], ['2026-09-05', 1100], ['2026-09-10', 1200],
    ]), NOW)
    const slow = computeTrend(from([
      ['2026-01-01', 1000], ['2026-05-01', 1100], ['2026-09-01', 1200],
    ]), NOW)
    expect(fast.perMonthPct!).toBeGreaterThan(slow.perMonthPct!)
  })
})

describe('six-month and yearly highs per card', () => {
  const NOW = new Date('2026-09-19T00:00:00Z')
  const from = (pairs: [string, number][]) => ({
    key: 'k',
    points: pairs.map(([date, price]) => ({ date, price, source: 'sale' as const })),
  })

  it('keeps a peak that fell outside six months out of the six-month high', () => {
    const series = from([
      ['2025-11-01', 30_000], // ~10 months ago
      ['2026-06-01', 20_000],
      ['2026-09-01', 21_000],
    ])
    expect(compute52WeekRange(series, null, NOW).high).toBe(30_000)
    expect(computeRange(series, null, NOW, SIX_MONTH_DAYS).high).toBe(21_000)
  })

  it('agrees with the yearly high when everything is recent', () => {
    const series = from([['2026-08-01', 900], ['2026-09-01', 1200]])
    expect(computeRange(series, null, NOW, SIX_MONTH_DAYS).high)
      .toBe(compute52WeekRange(series, null, NOW).high)
  })

  it('scales its confidence to the window it was asked for', () => {
    // Four months of dense coverage is most of a six-month window and only a
    // third of a year, so the same points cannot earn the same confidence.
    const dense = from(
      Array.from({ length: 24 }, (_, i) => [
        new Date(NOW.getTime() - (120 - i * 5) * 86_400_000).toISOString().slice(0, 10),
        1000 + i,
      ] as [string, number]),
    )
    const six = computeRange(dense, null, NOW, SIX_MONTH_DAYS)
    const year = compute52WeekRange(dense, null, NOW)
    expect(six.confidence).toBe('medium')
    expect(year.confidence).toBe('low')
  })

  it('marks a window too thin to be a real high', () => {
    const thin = from([['2026-09-10', 1000], ['2026-09-12', 1100]])
    expect(compute52WeekRange(thin, null, NOW).estimated).toBe(true)
  })

  it('reports no high at all when there is nothing in the window', () => {
    expect(computeRange(from([['2023-01-01', 500]]), null, NOW, SIX_MONTH_DAYS).high).toBeNull()
  })
})

describe('the last completed sale', () => {
  const NOW = new Date('2026-09-19T00:00:00Z')
  const series = (pts: [string, number, string | undefined][]) => ({
    key: 'k',
    points: pts.map(([date, price, venue]) => ({ date, price, source: 'sale' as const, venue })),
  })

  it('is the most recent sale, whatever venue it happened on', () => {
    // Requiring eBay reported nothing for a card that had plainly just sold.
    const last = lastSaleAt(series([
      ['2026-09-01', 4100, 'ebay'],
      ['2026-09-18', 18_300, 'fanatics'],
    ]), NOW)
    expect(last).toMatchObject({ price: 18_300, venue: 'fanatics' })
  })

  it('still works for comps stored before venues were recorded', () => {
    const last = lastSaleAt(series([['2026-09-18', 18_300, undefined]]), NOW)
    expect(last).toMatchObject({ price: 18_300, venue: null })
  })

  it('agrees with the yearly high when the last sale is the highest', () => {
    // The number the user saw in one column has to be available to the other.
    const s = series([['2026-03-01', 12_000, 'ebay'], ['2026-09-18', 18_300, undefined]])
    expect(compute52WeekRange(s, null, NOW).high).toBe(18_300)
    expect(lastSaleAt(s, NOW)!.price).toBe(18_300)
  })

  it('reports how stale it is, so an old price can be seen to be old', () => {
    expect(lastSaleAt(series([['2026-08-20', 900, 'ebay']]), NOW)!.ageDays).toBe(30)
  })

  it('has nothing to say when there are no sales at all', () => {
    expect(lastSaleAt({ key: 'k', points: [] }, NOW)).toBeNull()
  })

  it('ignores sales older than the valuation window', () => {
    expect(lastSaleAt(series([['2024-01-01', 500, 'ebay']]), NOW)).toBeNull()
  })

  it('leaves market value alone — that is still the median of recent comps', () => {
    const s = series([
      ['2026-09-01', 4000, 'ebay'],
      ['2026-09-05', 4200, 'fanatics'],
      ['2026-09-10', 9900, 'ebay'],
    ])
    expect(computeFmv(s, NOW).fmv).toBe(4200)
    expect(lastSaleAt(s, NOW)!.price).toBe(9900)
  })
})

describe('what a graded card is told about its own pricing', () => {
  const day = 86_400_000
  const END = Date.UTC(2026, 8, 21)
  const at = (d: number) => new Date(END - d * day).toISOString().slice(0, 10)
  const NOW = new Date(END)

  const psa10 = { grade: 10, cert: '93083876' }
  /** A provider quote for an ungraded copy, which is all the feed ever has. */
  const RAW_QUOTE: PriceSeries['quote'] = { market: 900, currency: 'USD', provider: 'pokemontcg.io' }

  const analyse = (points: PricePoint[], quote?: PriceSeries['quote']) =>
    analyzeItem(
      { key: 'k', points, quote, quoteExcluded: !!quote },
      null, NOW, { withForecast: false },
    )

  const SALES: PricePoint[] = [
    { date: at(200), price: 20000, source: 'sale' },
    { date: at(120), price: 22000, source: 'sale' },
    { date: at(40), price: 24000, source: 'sale' },
  ]

  it('says nothing at all when the card is priced from its own grade', () => {
    expect(gradedPricingNote(psa10, analyse(SALES))).toBeNull()
  })

  it('stays quiet even when a raw quote is also hanging about', () => {
    // The quote is excluded, but the sold comps are doing the work, so there
    // is nothing to explain and the old note was simply wrong here.
    const note = gradedPricingNote(psa10, analyse(SALES, RAW_QUOTE))
    expect(note).toBeNull()
  })

  it('names the cert and the button when no comps have been fetched', () => {
    const note = gradedPricingNote(psa10, analyse([]))!
    expect(note).toMatch(/93083876/)
    expect(note).toMatch(/Fetch sold comps/)
  })

  it('mentions the raw quote only when one is actually being excluded', () => {
    expect(gradedPricingNote(psa10, analyse([], RAW_QUOTE))!).toMatch(/raw copy/)
    expect(gradedPricingNote(psa10, analyse([]))!).not.toMatch(/raw copy/)
  })

  it('asks for a cert when the card has none', () => {
    const note = gradedPricingNote({ grade: 10 }, analyse([]))!
    expect(note).toMatch(/no certificate number/i)
    expect(note).toMatch(/Cert Number/)
  })

  it('says nothing about an ungraded card', () => {
    expect(gradedPricingNote({ grade: null }, analyse([]))).toBeNull()
  })
})

describe('a traded range is built from trades', () => {
  const SALES: PricePoint[] = [
    { date: daysBack(330), price: 1180, source: 'sale' },
    { date: daysBack(280), price: 1450, source: 'sale' },
    { date: daysBack(160), price: 980, source: 'sale' },
    { date: daysBack(80), price: 900, source: 'sale' },
    { date: daysBack(40), price: 870, source: 'sale' },
    { date: daysBack(15), price: 950, source: 'sale' },
  ]
  /** The same card, plus an ask nobody took and a figure from a sheet. */
  const NOISY: PricePoint[] = [
    ...SALES,
    { date: daysBack(30), price: 2400, source: 'listing' },
    { date: daysBack(25), price: 2200, source: 'user' },
    { date: daysBack(10), price: 400, source: 'snapshot' },
  ]

  it('gives the same high and low whatever opinions surround the trades', () => {
    const clean = compute52WeekRange(series(SALES), 950, NOW)
    const noisy = compute52WeekRange(series(NOISY), 950, NOW)
    expect(noisy.high).toBe(clean.high)
    expect(noisy.low).toBe(clean.low)
    expect(noisy.fromTrades).toBe(true)
  })

  it('does not let an asking price set the yearly high', () => {
    // The old band reached 2400 on an ask nobody accepted.
    expect(compute52WeekRange(series(NOISY), 950, NOW).high).toBe(1450)
  })

  it('falls back to what it has when nothing has sold, and says so', () => {
    const asksOnly = series([
      { date: daysBack(40), price: 2400, source: 'listing' },
      { date: daysBack(10), price: 2200, source: 'user' },
    ])
    const r = compute52WeekRange(asksOnly, 2300, NOW)
    expect(r.fromTrades).toBe(false)
    expect(r.estimated).toBe(true)
    expect(r.high).not.toBeNull()
  })
})

describe('an entry price the market would actually meet', () => {
  const TRADED: PricePoint[] = [
    { date: daysBack(330), price: 1180, source: 'sale' },
    { date: daysBack(280), price: 1450, source: 'sale' },
    { date: daysBack(210), price: 1020, source: 'sale' },
    { date: daysBack(160), price: 980, source: 'sale' },
    { date: daysBack(120), price: 1310, source: 'sale' },
    { date: daysBack(80), price: 900, source: 'sale' },
    { date: daysBack(40), price: 870, source: 'sale' },
    { date: daysBack(15), price: 950, source: 'sale' },
  ]
  const entryFor = (asking: number) => {
    const s = series(TRADED)
    const fmv = computeFmv(s, NOW)
    return { entry: computeEntry(fmv, compute52WeekRange(s, asking, NOW), s, asking, NOW), fmv }
  }

  it('sits inside the band the card actually trades in', () => {
    const { entry } = entryFor(950)
    expect(entry.entryPrice!).toBeGreaterThanOrEqual(870)
    expect(entry.entryPrice!).toBeLessThanOrEqual(1450)
  })

  it('does not demand a discount nobody would ever accept', () => {
    // The old model asked for up to 30% off fair value. Nobody sells at 70%
    // of what their card is worth, so that target was never going to be met.
    const { entry, fmv } = entryFor(950)
    expect(entry.entryPrice! / fmv.fmv!).toBeGreaterThan(0.85)
  })

  it('puts the floor at the lowest the market has gone, not below it', () => {
    expect(entryFor(950).entry.stretchEntry).toBe(870)
  })

  it('says how far off the high both the target and the ask are', () => {
    const { entry } = entryFor(905)
    expect(entry.entryDownFromHigh).toBeGreaterThan(0.3)
    expect(entry.askingDownFromHigh).toBeGreaterThan(0.35)
    expect(entry.rationale.join(' ')).toMatch(/off this year's high/)
  })

  it('calls an ask at the floor a strong buy, since nothing deeper has happened', () => {
    expect(entryFor(875).entry.verdict).toBe('strong_buy')
  })

  it('reads an ask near the high as paying what the keenest buyer paid', () => {
    expect(['rich', 'overpriced']).toContain(entryFor(1400).entry.verdict)
  })

  it('still ranks a cheaper ask above a dearer one', () => {
    expect(entryFor(900).entry.score).toBeGreaterThan(entryFor(1300).entry.score)
  })
})

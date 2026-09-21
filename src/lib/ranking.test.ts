import { describe, expect, it } from 'vitest'
import { analyzeItem } from './analytics'
import { drawdownFromHigh, rankItem, rankWatchlist, recentTrend } from './ranking'
import type { ItemAnalysis, PricePoint, PriceSeries, WatchItem } from './types'

const day = 86_400_000
const END = Date.UTC(2026, 8, 14)
const at = (daysAgo: number) => new Date(END - daysAgo * day).toISOString().slice(0, 10)
const NOW = new Date(END)

const watch = (name: string, askingPrice?: number): WatchItem =>
  ({ name, set: 'Base Set', number: '4', askingPrice } as WatchItem)

/** Build a real series and analysis from a price path, tested end to end. */
const build = (prices: [number, number][], asking?: number) => {
  const points: PricePoint[] = prices.map(([daysAgo, price]) => ({
    date: at(daysAgo), price, source: 'sale',
  }))
  const series: PriceSeries = { key: 'k', points }
  return { series, analysis: analyzeItem(series, asking ?? null, NOW) }
}

const analyse = (prices: [number, number][], asking?: number): ItemAnalysis =>
  build(prices, asking).analysis

/** Rank a path the way the app does, with both the analysis and the series. */
const rank = (name: string, prices: [number, number][], asking?: number) => {
  const { series, analysis } = build(prices, asking)
  return rankItem(watch(name, asking), name, analysis, series, NOW)
}

/** Steady climb to a peak, then a long slide that is still going. */
const FALLING_KNIFE: [number, number][] = [
  [720, 4000], [640, 4600], [560, 5200], [480, 5000], [400, 4200],
  [320, 3400], [240, 2800], [160, 2200], [80, 1700], [20, 1400],
]

/** Fell hard, bottomed out, and has been recovering for six months. */
const RECOVERED: [number, number][] = [
  [720, 4000], [640, 4400], [560, 3200], [480, 2400], [400, 2000],
  [320, 1900], [240, 2100], [160, 2400], [80, 2700], [20, 2900],
]

/** Never fell and sits at its high. */
const AT_HIGH: [number, number][] = [
  [720, 2000], [640, 2100], [560, 2250], [480, 2400], [400, 2500],
  [320, 2650], [240, 2800], [160, 2950], [80, 3050], [20, 3200],
]

describe('distance from the all-time high', () => {
  it('measures how far the last sale sits below the peak', () => {
    const d = drawdownFromHigh(analyse(FALLING_KNIFE))!
    // Peaked at 5200, last sold 1400.
    expect(d).toBeGreaterThan(0.7)
    expect(d).toBeLessThan(0.78)
  })

  it('is nothing for a card at its high', () => {
    expect(drawdownFromHigh(analyse(AT_HIGH))!).toBeLessThan(0.02)
  })
})

describe('what the ranking rewards', () => {
  it('prefers a card that fell and recovered over one still falling', () => {
    const knife = rank('knife', FALLING_KNIFE)
    const back = rank('back', RECOVERED)
    expect(back.score).toBeGreaterThan(knife.score)
  })

  it('says out loud when a card is cheap because it is dropping', () => {
    const knife = rank('knife', FALLING_KNIFE)
    expect(knife.warnings.join(' ')).toMatch(/still falling/i)
    expect(knife.warnings.join(' ')).toMatch(/not the same as cheap/i)
  })

  it('raises no such warning for one that has stopped falling', () => {
    const back = rank('back', RECOVERED)
    expect(back.warnings.join(' ')).not.toMatch(/still falling/i)
  })

  it('never calls a card strong while a warning stands against it', () => {
    const knife = rank('knife', FALLING_KNIFE)
    expect(knife.verdict).not.toBe('strong')
  })

  it('rewards an asking price below the entry target', () => {
    const cheap = rank('a', RECOVERED, 1800)
    const dear = rank('b', RECOVERED, 4200)
    expect(cheap.score).toBeGreaterThan(dear.score)
  })

  it('does not reward a drawdown without limit', () => {
    // Past the cap, a deeper hole stops counting as a better opportunity.
    const deep = analyse([[720, 10000], [600, 9000], [480, 5000], [360, 2000],
      [240, 1200], [120, 900], [20, 850]])
    const deeper = analyse([[720, 10000], [600, 9000], [480, 5000], [360, 2000],
      [240, 900], [120, 500], [20, 300]])
    const a = rankItem(watch('a'), 'a', deep, undefined, NOW).components.find((c) => c.key === 'drawdown')!
    const b = rankItem(watch('b'), 'b', deeper, undefined, NOW).components.find((c) => c.key === 'drawdown')!
    expect(a.score).toBe(1)
    expect(b.score).toBe(1)
  })

  it('shows what each part contributed, so the order can be argued with', () => {
    const r = rank('a', RECOVERED, 2500)
    const keys = r.components.map((c) => c.key)
    expect(keys).toContain('drawdown')
    expect(keys).toContain('steadiness')
    expect(r.reasons.length).toBe(r.components.length)
    for (const c of r.components) {
      expect(c.score).toBeGreaterThanOrEqual(0)
      expect(c.score).toBeLessThanOrEqual(1)
    }
  })
})

describe('what the ranking refuses to do', () => {
  it('gives no score at all to a card with no record', () => {
    const r = rankItem(watch('x'), 'x', undefined, undefined, NOW)
    expect(r.verdict).toBe('no data')
    expect(r.warnings.join(' ')).toMatch(/nothing to rank/i)
  })

  it('sorts the unrankable to the back rather than among the poor ones', () => {
    const good = build(RECOVERED)
    const bad = build(FALLING_KNIFE)
    const ranked = rankWatchlist(
      [watch('good'), watch('unknown'), watch('bad')],
      (w) => w.name,
      new Map([['good', good.analysis], ['bad', bad.analysis]]),
      new Map([['good', good.series], ['bad', bad.series]]),
      NOW,
    )
    expect(ranked[ranked.length - 1].verdict).toBe('no data')
    expect(ranked[0].key).toBe('good')
  })

  it('warns when the all-time high rests on almost nothing', () => {
    const r = rank('a', [[300, 1000], [150, 1400], [20, 900]])
    expect(r.warnings.join(' ')).toMatch(/all time. is a short time/i)
  })

  it('does not punish a card for a component it could not measure', () => {
    // No asking price, so no value component - the rest must still renormalize
    // to a comparable score rather than being diluted toward zero.
    const withAsking = rank('a', RECOVERED, 2500)
    const without = rank('b', RECOVERED)
    expect(without.components.some((c) => c.key === 'value')).toBe(false)
    expect(without.score).toBeGreaterThan(0)
    expect(Math.abs(without.score - withAsking.score)).toBeLessThan(45)
  })
})

describe('saying rates the way a person would', () => {
  it('converts a fast log trend rather than printing it raw', () => {
    // A card climbing steeply: the log rate and the real one part company, and
    // printing the log rate would understate it badly.
    const steep: [number, number][] = [
      [250, 400], [200, 620], [150, 900], [100, 1400], [50, 2100], [10, 3000],
    ]
    const r = rank('steep', steep)
    const lately = r.components.find((c) => c.key === 'steadiness')!
    const shown = Number(lately.detail.match(/(\d+)%/)![1])
    // Roughly sixfold over nine months is several hundred per cent a year, not
    // the ~190 the log rate alone would read.
    expect(shown).toBeGreaterThan(220)
  })
})

describe('the guard against a falling knife is always there', () => {
  /** Sales years apart, as a card that trades twice a year really has. */
  const SPARSE_DECLINE: [number, number][] = [
    [700, 8000], [520, 6000], [330, 4200], [150, 3000], [30, 2400],
  ]

  it('reads a trend from a card with nothing sold in months', () => {
    const t = recentTrend({ key: 'k', points: SPARSE_DECLINE.map(([d, price]) => ({
      date: at(d), price, source: 'sale' as const,
    })) }, NOW)!
    expect(t).not.toBeNull()
    expect(t.perYear).toBeLessThan(0)
  })

  it('still measures steadiness when a fixed window would have found nothing', () => {
    // Only one sale in the last 90 days and two in the last nine months, so
    // every calendar window this used to try would have come up empty.
    const r = rank('sparse', SPARSE_DECLINE)
    expect(r.components.some((c) => c.key === 'steadiness')).toBe(true)
  })

  it('flags a cheap card that is still sliding, however rarely it trades', () => {
    const r = rank('sparse', SPARSE_DECLINE)
    expect(r.warnings.join(' ')).toMatch(/still falling/i)
    expect(r.verdict).not.toBe('strong')
  })

  it('says how long the sales it read actually span', () => {
    const r = rank('sparse', SPARSE_DECLINE)
    const lately = r.components.find((c) => c.key === 'steadiness')!
    expect(lately.detail).toMatch(/spanning/)
    expect(lately.detail).toMatch(/last \d+ sales/)
  })

  it('admits when a cheap card has too little record to judge at all', () => {
    // Deeply down, and only two sales ever - no direction can be read.
    const r = rank('bare', [[400, 5000], [30, 1200]])
    expect(r.components.some((c) => c.key === 'steadiness')).toBe(false)
    expect(r.warnings.join(' ')).toMatch(/too few sales on record to tell whether it has stopped falling/i)
  })

  it('ignores a forward-dated row rather than reading a trend from it', () => {
    const withFuture: [number, number][] = [...SPARSE_DECLINE, [-200, 99_000]]
    const t = recentTrend({ key: 'k', points: withFuture.map(([d, price]) => ({
      date: at(d), price, source: 'sale' as const,
    })) }, NOW)!
    expect(t.perYear).toBeLessThan(0)
  })
})

describe('contradictions are said out loud, not left on screen', () => {
  /** Sliding hard, but only a little off its peak, so no drawdown warning. */
  const SLIDING_FROM_NEAR_PEAK: [number, number][] = [
    [400, 1000], [330, 1150], [260, 1300], [190, 1180], [120, 1000], [40, 880],
  ]

  it('flags a card that is falling even when it is near its high', () => {
    const r = rank('slide', SLIDING_FROM_NEAR_PEAK)
    const drawdown = r.components.find((c) => c.key === 'drawdown')!
    expect(drawdown.score).toBeLessThan(1)
    expect(r.warnings.join(' ')).toMatch(/falling at/i)
  })

  it('never shows a falling card with nothing said against it', () => {
    const r = rank('slide', SLIDING_FROM_NEAR_PEAK)
    const lately = r.components.find((c) => c.key === 'steadiness')!
    if (lately.detail.startsWith('Falling')) expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('admits when a positive forecast disagrees with the card’s own sales', () => {
    const r = rank('slide', SLIDING_FROM_NEAR_PEAK)
    const year = r.analysis?.forecast?.projections.find((p) => p.years === 1)
    if (year && year.roiMid > 0.02) {
      expect(r.warnings.join(' ')).toMatch(/mostly the market/i)
      expect(r.warnings.join(' ')).toMatch(/more optimistic than its own recent sales/i)
    }
  })

  it('says nothing of the sort about a card that is actually rising', () => {
    const r = rank('up', [[400, 800], [320, 900], [240, 1000], [160, 1150], [80, 1250], [20, 1400]])
    expect(r.warnings.join(' ')).not.toMatch(/falling at/i)
    expect(r.warnings.join(' ')).not.toMatch(/mostly the market/i)
  })
})

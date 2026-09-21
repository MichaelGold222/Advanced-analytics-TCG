import { describe, expect, it } from 'vitest'
import {
  MIN_CARDS_FOR_INDEX, buildRepeatSalesIndex, collectRepeatSales, estimateBeta, indexChangeBetween,
  indexLevelAt, repeatSalesFor,
} from './marketindex'
import type { PricePoint, PriceSeries } from './types'

const day = 86_400_000
const START = Date.UTC(2025, 0, 1)

const iso = (dayOffset: number) => new Date(START + dayOffset * day).toISOString().slice(0, 10)

const sale = (dayOffset: number, price: number): PricePoint =>
  ({ date: iso(dayOffset), price, source: 'sale' })

/**
 * A synthetic market: every card follows one common path, times its own level,
 * times whatever idiosyncratic noise it is given. Recovering the common path
 * from the sales alone is the whole job, so the tests know the right answer.
 */
function syntheticMarket(opts: {
  cards: number
  salesPerCard: number
  /** Log level of the market on a given day. */
  path: (dayOffset: number) => number
  noise?: number
  spanDays?: number
}): Map<string, PriceSeries> {
  const { cards, salesPerCard, path, noise = 0, spanDays = 730 } = opts
  const out = new Map<string, PriceSeries>()
  // A fixed, ugly generator: reproducible, and not so regular that a bug
  // cancels out across cards.
  let seed = 12345
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let c = 0; c < cards; c++) {
    const base = 100 * (1 + c)
    const points: PricePoint[] = []
    for (let s = 0; s < salesPerCard; s++) {
      // Stagger the cards so sales are not all on the same dates.
      const offset = Math.round((s * spanDays) / (salesPerCard - 1) + (c * 7) % 23)
      const at = Math.min(spanDays, offset)
      const shock = noise > 0 ? (rand() - 0.5) * 2 * noise : 0
      points.push(sale(at, base * Math.exp(path(at) + shock)))
    }
    out.set(`card-${c}`, { key: `card-${c}`, points })
  }
  return out
}

describe('repeat sales', () => {
  it('pairs each sale with the next, not with every other', () => {
    const series: PriceSeries = { key: 'k', points: [sale(0, 100), sale(30, 110), sale(60, 120)] }
    const pairs = repeatSalesFor('k', series)
    expect(pairs).toHaveLength(2)
    expect(pairs.map((p) => p.gapDays)).toEqual([30, 30])
  })

  it('ignores quotes and asks, which are opinions rather than prices paid', () => {
    const series: PriceSeries = {
      key: 'k',
      points: [
        sale(0, 100),
        { date: iso(15), price: 999, source: 'listing' },
        { date: iso(20), price: 888, source: 'market' },
        sale(30, 110),
      ],
    }
    expect(repeatSalesFor('k', series)).toHaveLength(1)
  })

  it('drops same-day repeats, which carry no elapsed time', () => {
    const series: PriceSeries = { key: 'k', points: [sale(10, 100), sale(10, 140)] }
    expect(repeatSalesFor('k', series)).toHaveLength(0)
  })

  it('gathers pairs across every card', () => {
    const market = syntheticMarket({ cards: 5, salesPerCard: 4, path: () => 0 })
    expect(collectRepeatSales(market)).toHaveLength(5 * 3)
  })
})

describe('recovering a known market path', () => {
  it('finds a steady climb that every card shares', () => {
    // 30% a year, compounded in logs, over two years.
    const market = syntheticMarket({
      cards: 12, salesPerCard: 8, path: (d) => (0.3 * d) / 365,
    })
    const index = buildRepeatSalesIndex(market)!
    expect(index).not.toBeNull()
    expect(index.driftPerYear).toBeGreaterThan(0.24)
    expect(index.driftPerYear).toBeLessThan(0.36)
  })

  it('finds a decline just as readily', () => {
    const market = syntheticMarket({
      cards: 12, salesPerCard: 8, path: (d) => (-0.25 * d) / 365,
    })
    const index = buildRepeatSalesIndex(market)!
    expect(index.driftPerYear).toBeLessThan(-0.19)
    expect(index.driftPerYear).toBeGreaterThan(-0.31)
  })

  it('calls a flat market flat rather than finding a trend in noise', () => {
    const market = syntheticMarket({
      cards: 14, salesPerCard: 8, path: () => 0, noise: 0.12,
    })
    const index = buildRepeatSalesIndex(market)!
    expect(Math.abs(index.driftPerYear)).toBeLessThan(0.1)
  })

  it('finds the turn in a market that rises then falls, at the right time', () => {
    // Up 40% over the first year, back down over the second.
    const peak = 365
    const market = syntheticMarket({
      cards: 14, salesPerCard: 10,
      path: (d) => (d <= peak ? (0.4 * d) / peak : 0.4 - (0.4 * (d - peak)) / peak),
    })
    const index = buildRepeatSalesIndex(market)!

    const top = index.points.reduce((a, b) => (b.logLevel > a.logLevel ? b : a))
    const daysOff = Math.abs(
      (new Date(`${top.date}T00:00:00Z`).getTime() - (START + peak * day)) / day,
    )
    // The peak is found within one period of where it really was. It cannot do
    // better than that: a period is the index's resolution, and a turn inside
    // one is averaged along with everything else in it.
    expect(daysOff).toBeLessThanOrEqual(index.periodDays)

    // Both legs show up as real movement, though a bucketed index always
    // reads a sharp peak as lower than it was - the sales either side of the
    // turn are averaged into the same period as the turn itself.
    const start = index.points[0].logLevel
    const end = index.points[index.points.length - 1].logLevel
    expect(top.logLevel - start).toBeGreaterThan(0.2)
    expect(top.logLevel - end).toBeGreaterThan(0.2)

    // The net over the whole span is roughly nothing, and the index says so
    // rather than reporting the first leg and forgetting the second.
    expect(Math.abs(index.driftPerYear)).toBeLessThan(0.12)
  })

  it('is not thrown off by one card behaving unlike the rest', () => {
    const market = syntheticMarket({
      cards: 14, salesPerCard: 8, path: (d) => (0.2 * d) / 365,
    })
    // One card collapses to a tenth over the span; the market did not.
    market.set('rogue', {
      key: 'rogue',
      points: [sale(0, 5000), sale(240, 1500), sale(480, 700), sale(720, 500)],
    })
    const index = buildRepeatSalesIndex(market)!
    expect(index.driftPerYear).toBeGreaterThan(0.1)
    expect(index.driftPerYear).toBeLessThan(0.3)
  })
})

describe('refusing to build one', () => {
  it('returns null when there are barely any repeat sales', () => {
    const market = syntheticMarket({ cards: 3, salesPerCard: 2, path: () => 0 })
    expect(buildRepeatSalesIndex(market)).toBeNull()
  })

  it('returns null when the pairs come from too few cards to be a market', () => {
    const market = syntheticMarket({
      cards: MIN_CARDS_FOR_INDEX - 1, salesPerCard: 12, path: () => 0,
    })
    expect(buildRepeatSalesIndex(market)).toBeNull()
  })

  it('returns null on an empty collection', () => {
    expect(buildRepeatSalesIndex(new Map())).toBeNull()
  })
})

describe('the shape of the index', () => {
  it('widens its periods rather than estimating months it cannot fill', () => {
    const sparse = syntheticMarket({ cards: 6, salesPerCard: 4, path: () => 0 })
    const dense = syntheticMarket({ cards: 40, salesPerCard: 12, path: () => 0 })
    const a = buildRepeatSalesIndex(sparse)!
    const b = buildRepeatSalesIndex(dense)!
    expect(a.periodDays).toBeGreaterThan(b.periodDays)
  })

  it('interpolates a period with no sales instead of inventing a spike', () => {
    // A quiet stretch in the middle: nothing trades for about half a year
    // while the market climbs steadily either side of it.
    const market = new Map<string, PriceSeries>()
    for (let c = 0; c < 16; c++) {
      const base = 100 * (1 + c)
      const at = [0, 60, 120, 180, 560, 620, 680, 730].map((d) => d + (c * 5) % 17)
      market.set(`c${c}`, {
        key: `c${c}`,
        points: at.map((d) => sale(d, base * Math.exp((0.3 * d) / 365))),
      })
    }
    const index = buildRepeatSalesIndex(market)!
    // Whatever the gap, the index must stay monotone through it rather than
    // lurching: the prior's whole job is to bridge a period nothing pins down.
    const levels = index.points.map((p) => p.logLevel)
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]).toBeGreaterThanOrEqual(levels[i - 1] - 0.02)
    }
    expect(index.driftPerYear).toBeGreaterThan(0.2)
    expect(index.driftPerYear).toBeLessThan(0.4)
  })

  it('starts at zero, because an index has no natural origin', () => {
    const market = syntheticMarket({ cards: 12, salesPerCard: 8, path: (d) => (0.3 * d) / 365 })
    expect(buildRepeatSalesIndex(market)!.points[0].logLevel).toBe(0)
  })

  it('reports how much it was built from, so thin ones can be spotted', () => {
    const market = syntheticMarket({ cards: 12, salesPerCard: 8, path: () => 0 })
    const index = buildRepeatSalesIndex(market)!
    expect(index.cardCount).toBe(12)
    expect(index.pairCount).toBeGreaterThan(50)
  })

  it('measures its own volatility from how much it actually moved', () => {
    const calm = buildRepeatSalesIndex(syntheticMarket({
      cards: 16, salesPerCard: 10, path: () => 0,
    }))!
    const choppy = buildRepeatSalesIndex(syntheticMarket({
      cards: 16, salesPerCard: 10, path: (d) => 0.3 * Math.sin(d / 40),
    }))!
    expect(choppy.volatility).toBeGreaterThan(calm.volatility)
  })
})

describe('reading a level off the index', () => {
  const market = syntheticMarket({ cards: 12, salesPerCard: 8, path: (d) => (0.3 * d) / 365 })
  const index = buildRepeatSalesIndex(market)!

  it('interpolates between periods rather than stepping', () => {
    const a = indexLevelAt(index, index.points[0].date)
    const b = indexLevelAt(index, index.points[1].date)
    const between = new Date(
      (new Date(`${index.points[0].date}T00:00:00Z`).getTime()
        + new Date(`${index.points[1].date}T00:00:00Z`).getTime()) / 2,
    ).toISOString().slice(0, 10)
    const mid = indexLevelAt(index, between)
    expect(mid).toBeGreaterThan(Math.min(a, b))
    expect(mid).toBeLessThan(Math.max(a, b))
  })

  it('stays flat past either end instead of extrapolating a trend', () => {
    const first = index.points[0]
    const last = index.points[index.points.length - 1]
    expect(indexLevelAt(index, '2000-01-01')).toBe(first.logLevel)
    expect(indexLevelAt(index, '2099-01-01')).toBe(last.logLevel)
  })

  it('reports the change across a span in logs', () => {
    const change = indexChangeBetween(index, iso(0), iso(365))
    expect(change).toBeGreaterThan(0.2)
    expect(change).toBeLessThan(0.4)
  })
})

describe('splitting a card into the market and itself', () => {
  // Beta is only measurable against a market with shape. A market that rose a
  // steady amount every day is indistinguishable from elapsed time, so this
  // one speeds up, stalls and turns over the two years.
  const WAVY = (d: number) => 0.25 * Math.sin(d / 90) + (0.1 * d) / 365
  const index = buildRepeatSalesIndex(
    syntheticMarket({ cards: 18, salesPerCard: 11, path: WAVY }),
  )!

  /** A card that follows the market, amplified by `gearing`, plus its own drift. */
  // Irregular gaps, as real sales have - a card does not trade on a metronome.
  const geared = (gearing: number, ownDriftPerYear = 0): PricePoint[] =>
    [0, 41, 130, 176, 268, 351, 402, 495, 559, 640, 700].map((d) =>
      sale(d, 1000 * Math.exp(gearing * WAVY(d) + (ownDriftPerYear * d) / 365)))

  it('recognizes a card that simply moves with the market', () => {
    const b = estimateBeta(geared(1), index)!
    expect(b.separable).toBe(true)
    expect(b.beta).toBeGreaterThan(0.7)
    expect(b.beta).toBeLessThan(1.4)
    expect(b.marketShare).toBeGreaterThan(0.8)
  })

  it('ranks a geared card above a sluggish one', () => {
    const hard = estimateBeta(geared(2), index)!
    const with1 = estimateBeta(geared(1), index)!
    const soft = estimateBeta(geared(0.2), index)!
    expect(hard.rawBeta).toBeGreaterThan(with1.rawBeta)
    expect(with1.rawBeta).toBeGreaterThan(soft.rawBeta)
    expect(soft.rawBeta).toBeLessThan(0.6)
  })

  it('reports a strong beta pulled toward one, not at face value', () => {
    const b = estimateBeta(geared(2), index)!
    expect(b.rawBeta).toBeGreaterThan(1.5)
    // Eleven sales cannot tell 2.0 from 1.5, so what is reported sits between
    // the measurement and the assumption that it is an ordinary card.
    expect(b.beta).toBeLessThan(b.rawBeta)
    expect(b.beta).toBeGreaterThan(1.2)
  })

  it('credits the market for what the market did, not the card', () => {
    const b = estimateBeta(geared(1), index)!
    expect(Math.abs(b.rawAlphaPerDay) * 365).toBeLessThan(0.12)
    expect(b.idiosyncratic).toBeLessThan(0.2)
  })

  it('finds drift the market does not explain', () => {
    const plain = estimateBeta(geared(1), index)!
    const extra = estimateBeta(geared(1, 0.25), index)!
    expect(extra.rawAlphaPerDay - plain.rawAlphaPerDay).toBeGreaterThan(0.0004)
    expect((extra.rawAlphaPerDay - plain.rawAlphaPerDay) * 365).toBeGreaterThan(0.15)
    expect((extra.rawAlphaPerDay - plain.rawAlphaPerDay) * 365).toBeLessThan(0.35)
  })

  it('reports a low market share for a card doing its own thing', () => {
    const erratic = [0, 90, 180, 270, 360, 450, 540, 630, 700]
      .map((d, i) => sale(d, 1000 * [1, 1.6, 0.8, 1.5, 0.7, 1.4, 0.75, 1.55, 0.9][i]))
    const b = estimateBeta(erratic, index)!
    expect(b.marketShare).toBeLessThan(0.6)
    expect(b.idiosyncratic).toBeGreaterThan(0.3)
  })

  it('refuses when a card has barely sold', () => {
    expect(estimateBeta([sale(0, 100), sale(100, 110)], index)).toBeNull()
  })

  it('assumes an ordinary card when the index sat still across its sales', () => {
    const flat = buildRepeatSalesIndex(syntheticMarket({
      cards: 16, salesPerCard: 10, path: () => 0,
    }))!
    const b = estimateBeta(geared(1), flat)!
    expect(b.separable).toBe(false)
    expect(b.beta).toBe(1)
    expect(b.marketShare).toBe(0)
  })

  it('declines to split when the market only ever rose a steady amount', () => {
    // A straight line in logs: sensitivity and own drift are the same variable,
    // so no split is possible and it says so rather than picking one.
    const straight = buildRepeatSalesIndex(syntheticMarket({
      cards: 16, salesPerCard: 10, path: (d) => (0.3 * d) / 365,
    }))!
    const line = (d: number) => 1000 * Math.exp((0.6 * d) / 365)
    const b = estimateBeta([0, 90, 180, 270, 360, 450, 540, 630, 720].map((d) => sale(d, line(d))), straight)!
    expect(b.separable).toBe(false)
    expect(b.beta).toBe(1)
    // The whole excess over the market becomes the card's own drift: it rose
    // 60% a year where the market rose 30%, so about 30% is unexplained.
    expect(b.rawAlphaPerDay * 365).toBeGreaterThan(0.15)
    expect(b.rawAlphaPerDay * 365).toBeLessThan(0.45)
  })
})

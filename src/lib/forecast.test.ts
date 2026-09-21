import { describe, expect, it } from 'vitest'
import {
  MAX_VOLATILITY, MIN_RETURNS_FOR_FORECAST, PRIOR_VOLATILITY, computeForecast, cumulativeDrift,
  dailyReturns, robustDrift, shrunkDrift, shrunkVolatility,
} from './forecast'
import { buildRepeatSalesIndex } from './marketindex'
import type { PricePoint, PriceSeries } from './types'

const series = (pairs: [string, number][]): PricePoint[] =>
  pairs.map(([date, price]) => ({ date, price, source: 'sale' }))

/** A steady climb, sampled monthly. */
const RISING = series([
  ['2026-01-01', 1000], ['2026-02-01', 1060], ['2026-03-01', 1120],
  ['2026-04-01', 1190], ['2026-05-01', 1260], ['2026-06-01', 1330],
])

describe('day-scaled returns', () => {
  it('makes a move over ninety days comparable to one over a week', () => {
    // Under a random walk spread grows with the square root of time, so the
    // same proportional move over a longer gap is a smaller daily rate.
    const short = dailyReturns(series([['2026-01-01', 100], ['2026-01-08', 110]]))[0]
    const long = dailyReturns(series([['2026-01-01', 100], ['2026-04-01', 110]]))[0]
    expect(short.rate).toBeGreaterThan(long.rate)
  })

  it('ignores two sales on the same day rather than dividing by zero', () => {
    expect(dailyReturns(series([['2026-01-01', 100], ['2026-01-01', 120]]))).toEqual([])
  })

  it('needs two prices to have a return at all', () => {
    expect(dailyReturns(series([['2026-01-01', 100]]))).toEqual([])
  })
})

describe('volatility on thin evidence', () => {
  it('falls back to the prior when a card has said nothing', () => {
    expect(shrunkVolatility([])).toBe(PRIOR_VOLATILITY)
  })

  it('pulls a calm-looking handful toward the prior rather than believing it', () => {
    const calm = dailyReturns(RISING)
    const own = shrunkVolatility(calm, 0)
    const shrunk = shrunkVolatility(calm, PRIOR_VOLATILITY)
    expect(shrunk).toBeGreaterThan(own)
    expect(shrunk).toBeLessThan(PRIOR_VOLATILITY)
  })

  it('leans less on the prior as evidence accumulates', () => {
    // Thirty sales spread across two years, roughly three weeks apart, which
    // is a densely traded card rather than an impossible one. The dates have
    // to be real and ordered: a set cycling through month and day strings
    // lands most of its pairs a day apart, where the gap floor now applies,
    // and then measures the floor rather than the shrinking.
    const start = Date.UTC(2024, 8, 21)
    const many = dailyReturns(series(
      Array.from({ length: 30 }, (_, i) => [
        new Date(start + i * 24 * 86_400_000).toISOString().slice(0, 10),
        1000 + i * 5 + (i % 3) * 40,
      ] as [string, number]),
    ))
    const few = dailyReturns(RISING.slice(0, 4))
    const distance = (v: number) => Math.abs(v - PRIOR_VOLATILITY)
    expect(distance(shrunkVolatility(many))).toBeGreaterThan(distance(shrunkVolatility(few)))
  })
})

describe('trend', () => {
  it('reads a steady climb as positive', () => {
    expect(robustDrift(RISING)!).toBeGreaterThan(0)
  })

  it('is not swung by one odd sale, where least squares would be', () => {
    const withOutlier = [...RISING, { date: '2026-06-15', price: 200, source: 'sale' as const }]
    // Five rising sales and one collapse: the median slope stays up.
    expect(robustDrift(withOutlier)!).toBeGreaterThan(0)
  })

  it('says nothing from two points', () => {
    expect(robustDrift(series([['2026-01-01', 100], ['2026-02-01', 120]]))).toBeNull()
  })
})

describe('the forecast itself', () => {
  it('refuses rather than guessing when the card is too thin', () => {
    expect(computeForecast(series([['2026-01-01', 100], ['2026-02-01', 110]]), 110)).toBeNull()
    expect(MIN_RETURNS_FOR_FORECAST).toBeGreaterThan(2)
  })

  it('refuses without a price to start from', () => {
    expect(computeForecast(RISING, null)).toBeNull()
    expect(computeForecast(RISING, 0)).toBeNull()
  })

  it('widens as the horizon lengthens, because uncertainty compounds', () => {
    const f = computeForecast(RISING, 1330)!
    const spread = (i: number) => f.bands[i].high - f.bands[i].low
    expect(spread(3)).toBeGreaterThan(spread(0))
  })

  it('brackets the starting price rather than drifting off it', () => {
    const f = computeForecast(RISING, 1330)!
    expect(f.bands[0].low).toBeLessThan(1330)
    expect(f.bands[0].high).toBeGreaterThan(1330)
  })

  it('gives the same answer twice, so a page refresh does not reprice a card', () => {
    const a = computeForecast(RISING, 1330)!
    const b = computeForecast(RISING, 1330)!
    expect(a.bands).toEqual(b.bands)
  })

  it('caps a trend too steep to carry forward', () => {
    // Four sales that quadrupled in a month would extrapolate to absurdity.
    const rocket = series([
      ['2026-01-01', 100], ['2026-01-08', 200], ['2026-01-15', 400],
      ['2026-01-22', 800], ['2026-02-01', 1600],
    ])
    const f = computeForecast(rocket, 1600)!
    expect(f.driftPerYear).toBeLessThanOrEqual(0.6)
    // A month of sales is no lever at all, so the trend is cut long before
    // the cap that used to be the only thing standing between it and absurdity.
    expect(f.driftShrunk).toBe(true)
    expect(f.rationale.join(' ')).toMatch(/a few weeks of sales cannot tell a trend/i)
  })

  it('says what it was built from, and that it is a range', () => {
    const said = computeForecast(RISING, 1330)!.rationale.join(' ')
    expect(said).toMatch(/resampled/i)
    expect(said).toMatch(/not a prediction/i)
  })

  it('reports a chance of rising between nothing and certainty', () => {
    const f = computeForecast(RISING, 1330)!
    for (const b of f.bands) {
      expect(b.chanceUp).toBeGreaterThan(0)
      expect(b.chanceUp).toBeLessThan(1)
    }
  })
})

describe('the simulation matches the volatility it reports', () => {
  it('does not claim certainty from a handful of tidy sales', () => {
    // Six points along a smooth line have almost no residual spread. Drawing
    // from that raw spread forecast the future as a certainty; the bands must
    // reflect the shrunk estimate instead.
    const f = computeForecast(RISING, 1330)!
    expect(f.bands[0].chanceUp).toBeLessThan(1)
    expect(f.bands[0].low).toBeLessThan(1330)
    expect(f.volatility).toBeGreaterThan(0.1)
  })

  it('widens the one-year band roughly in line with the volatility', () => {
    const f = computeForecast(RISING, 1000)!
    const year = f.bands.find((b) => b.horizonDays === 365)!
    // A 10-90 band is about 2.56 standard deviations wide in log terms.
    const impliedWidth = Math.log(year.high / year.low) / 2.56
    expect(impliedWidth).toBeGreaterThan(f.volatility * 0.5)
    expect(impliedWidth).toBeLessThan(f.volatility * 2)
  })

  it('gives a wilder card a wider band than a calm one', () => {
    const wild = series([
      ['2026-01-01', 1000], ['2026-02-01', 1600], ['2026-03-01', 700],
      ['2026-04-01', 1500], ['2026-05-01', 800], ['2026-06-01', 1400],
    ])
    const calmBand = computeForecast(RISING, 1000)!.bands[3]
    const wildBand = computeForecast(wild, 1000)!.bands[3]
    expect(wildBand.high - wildBand.low).toBeGreaterThan(calmBand.high - calmBand.low)
  })
})

describe('trend is shrunk harder than volatility, because it is known worse', () => {
  it('keeps almost none of a trend measured over a few months', () => {
    // Six months of lever against 30% volatility: the standard error on the
    // annual trend is 30/sqrt(0.5) = 42%, which swamps a 20% prior.
    const kept = shrunkDrift(0.001, 0.3, 182) / 0.001
    expect(kept).toBeLessThan(0.2)
  })

  it('keeps most of a trend measured over many years', () => {
    // Ten years reduces the same error to under 10%, well inside the prior.
    const kept = shrunkDrift(0.001, 0.3, 3650) / 0.001
    expect(kept).toBeGreaterThan(0.8)
  })

  it('pulls harder on a volatile card than a calm one over the same span', () => {
    const calm = shrunkDrift(0.001, 0.15, 730) / 0.001
    const wild = shrunkDrift(0.001, 0.6, 730) / 0.001
    expect(wild).toBeLessThan(calm)
  })

  it('refuses to carry a trend when there is no span at all', () => {
    expect(shrunkDrift(0.002, 0.3, 0)).toBe(0)
  })

  it('leaves a flat card flat rather than inventing a direction', () => {
    expect(shrunkDrift(0, 0.3, 730)).toBe(0)
  })

  it('no longer calls a two-year climb a near-certainty a year out', () => {
    // The old model carried the full measured trend and reported ~77% up on
    // a series this thin. The trend is real-looking but the span cannot
    // separate it from chance, so the claim has to come down.
    const f = computeForecast(RISING, 1330)
    expect(f).not.toBeNull()
    expect(f!.driftShrunk).toBe(true)
    const year = f!.bands.find((b) => b.horizonDays === 365)!
    expect(year.chanceUp).toBeLessThan(0.72)
    // But not flattened to a coin toss either - a real climb still leans up.
    expect(year.chanceUp).toBeGreaterThan(0.5)
  })

  it('says in words that the trend was cut, and by how much', () => {
    const f = computeForecast(RISING, 1330)
    expect(f!.rationale.join(' ')).toMatch(/cut from .*cannot tell a trend/)
  })
})

describe('forecasting against a market index', () => {
  const day = 86_400_000
  const START = Date.UTC(2025, 0, 1)
  const at = (d: number) => new Date(START + d * day).toISOString().slice(0, 10)
  const WAVY = (d: number) => 0.25 * Math.sin(d / 90) + (0.18 * d) / 365

  /** A collection whose cards all track one wavy, rising market. */
  const collection = () => {
    const out = new Map<string, PriceSeries>()
    for (let c = 0; c < 18; c++) {
      const base = 500 * (1 + c)
      const days = [0, 61, 128, 195, 260, 320, 399, 455, 520, 601, 668, 730]
      out.set(`c${c}`, {
        key: `c${c}`,
        points: days.map((d) => {
          const shifted = Math.min(730, d + (c * 11) % 29)
          return { date: at(shifted), price: base * Math.exp(WAVY(shifted)), source: 'sale' as const }
        }),
      })
    }
    return out
  }

  const index = buildRepeatSalesIndex(collection())!
  /** A card that rode the same market, sampled on its own irregular dates. */
  const rider = [0, 48, 139, 201, 288, 366, 430, 512, 588, 655, 719]
    .map((d) => ({ date: at(d), price: 2000 * Math.exp(WAVY(d)), source: 'sale' as const }))

  it('builds an index worth using from a collection this size', () => {
    expect(index.cardCount).toBeGreaterThanOrEqual(18)
    expect(index.pairCount).toBeGreaterThan(100)
  })

  it('reports the split, so the market is not silently doing the work', () => {
    const f = computeForecast(rider, 2000, { index })!
    expect(f.market).toBeDefined()
    expect(f.market!.marketShare).toBeGreaterThan(0.5)
    expect(f.market!.cardCount).toBe(index.cardCount)
  })

  it('says nothing about a market when there is no index', () => {
    expect(computeForecast(rider, 2000)!.market).toBeUndefined()
  })

  it("keeps more of the market's trend than it would keep of one card's", () => {
    // The market's trend rests on a hundred-odd pairs over two years and
    // survives being shrunk; the same card alone gets most of its trend cut.
    const withMarket = computeForecast(rider, 2000, { index })!
    const alone = computeForecast(rider, 2000)!
    expect(Math.abs(withMarket.driftPerYear)).toBeGreaterThan(Math.abs(alone.driftPerYear))
  })

  it('gives a geared card a wider band than one that barely moves with the market', () => {
    const geared = [0, 48, 139, 201, 288, 366, 430, 512, 588, 655, 719]
      .map((d) => ({ date: at(d), price: 2000 * Math.exp(2 * WAVY(d)), source: 'sale' as const }))
    const sluggish = [0, 48, 139, 201, 288, 366, 430, 512, 588, 655, 719]
      .map((d) => ({ date: at(d), price: 2000 * Math.exp(0.2 * WAVY(d)), source: 'sale' as const }))
    const g = computeForecast(geared, 2000, { index })!
    const s = computeForecast(sluggish, 2000, { index })!
    expect(g.market!.beta).toBeGreaterThan(s.market!.beta)
    const gYear = g.bands.find((b) => b.horizonDays === 365)!
    const sYear = s.bands.find((b) => b.horizonDays === 365)!
    expect(gYear.high - gYear.low).toBeGreaterThan(sYear.high - sYear.low)
  })

  it('still refuses a card too thin to model, index or no index', () => {
    const thin = [{ date: at(0), price: 100, source: 'sale' as const },
      { date: at(40), price: 110, source: 'sale' as const }]
    expect(computeForecast(thin, 110, { index })).toBeNull()
  })

  it('explains in words where the trend came from', () => {
    const said = computeForecast(rider, 2000, { index })!.rationale.join(' ')
    expect(said).toMatch(/paired prices across \d+ cards/)
    expect(said).toMatch(/of what this card has done was the whole market moving/)
  })

  it('gives the same answer twice with a market as without one', () => {
    const a = computeForecast(rider, 2000, { index })!
    const b = computeForecast(rider, 2000, { index })!
    expect(a.bands).toEqual(b.bands)
  })
})

describe('the long view', () => {
  it('refuses to compound a measured trend for a decade', () => {
    // RISING measures a strong climb. Carried straight, ten years of it would
    // be several times the money; the decay caps what a trend can ever add.
    const f = computeForecast(RISING, 1000)!
    const ten = f.projections.find((p) => p.years === 10)!
    expect(ten.mid / 1000).toBeLessThan(3)
  })

  it('caps the trend rather than merely slowing it', () => {
    // Whatever the horizon, a decaying trend converges on a finite total. Ten
    // years and twenty add almost the same amount from the trend alone.
    const decade = cumulativeDrift(0.0005, 0, 3650)
    const score = cumulativeDrift(0.0005, 0, 7300)
    expect(score - decade).toBeLessThan(decade * 0.1)
  })

  it('still carries most of the trend through the first year', () => {
    const year = cumulativeDrift(0.0005, 0, 365)
    expect(year).toBeGreaterThan(0.0005 * 365 * 0.75)
  })

  it('widens with the horizon, because a random walk does', () => {
    const f = computeForecast(RISING, 1000)!
    const [one, five, ten] = f.projections
    const width = (p: typeof one) => Math.log(p.high / p.low)
    expect(width(five)).toBeGreaterThan(width(one))
    expect(width(ten)).toBeGreaterThan(width(five))
  })

  it('reports a return against what a buyer would actually pay', () => {
    const cheap = computeForecast(RISING, 1000, { basis: 800 })!
    const dear = computeForecast(RISING, 1000, { basis: 1400 })!
    const roi = (f: typeof cheap) => f.projections.find((p) => p.years === 5)!.roiMid
    expect(roi(cheap)).toBeGreaterThan(roi(dear))
    expect(cheap.basis).toBe(800)
  })

  it('falls back to the starting price when no asking price is known', () => {
    const f = computeForecast(RISING, 1000)!
    expect(f.basis).toBe(1000)
    // Paying exactly what it is worth, the five-year odds of being ahead and
    // of being above the basis are the same question.
    const five = f.projections.find((p) => p.years === 5)!
    expect(five.chanceUp).toBe(five.chanceAboveBasis)
  })

  it('is harder to make money on when you overpay', () => {
    const f = computeForecast(RISING, 1000, { basis: 2000 })!
    const five = f.projections.find((p) => p.years === 5)!
    expect(five.chanceAboveBasis).toBeLessThan(five.chanceUp)
  })

  it('annualizes the return rather than reporting the whole gain', () => {
    const f = computeForecast(RISING, 1000)!
    const five = f.projections.find((p) => p.years === 5)!
    // The rate, compounded five times, has to land back on the value.
    expect(1000 * (1 + five.roiMid) ** 5).toBeCloseTo(five.mid, 0)
  })

  it('gives the same projections twice', () => {
    expect(computeForecast(RISING, 1000)!.projections)
      .toEqual(computeForecast(RISING, 1000)!.projections)
  })
})

describe('one set of futures, read at every horizon', () => {
  it('does not change a near band by asking for a further one', () => {
    // Each horizon used to get its own run of paths, drawn one after another,
    // so adding a longer horizon shifted every band before it. The horizons
    // are now readings off the same walks and must be independent.
    const short = computeForecast(RISING, 1330, { horizons: [30, 90] })!
    const long = computeForecast(RISING, 1330, { horizons: [30, 90, 180, 365] })!
    expect(long.bands.slice(0, 2)).toEqual(short.bands)
  })

  it('widens as the horizon lengthens, since the same paths carry on', () => {
    const f = computeForecast(RISING, 1330)!
    const widths = f.bands.map((b) => Math.log(b.high / b.low))
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThan(widths[i - 1])
  })

  it('returns the horizons in order however they were asked for', () => {
    const f = computeForecast(RISING, 1330, { horizons: [365, 30, 180] })!
    expect(f.bands.map((b) => b.horizonDays)).toEqual([30, 180, 365])
  })
})

describe('repeating a forecast', () => {
  it('gives an identical answer, cached or not', () => {
    const a = computeForecast(RISING, 1330)!
    const b = computeForecast(RISING, 1330)!
    expect(b).toEqual(a)
  })

  it('recomputes when a price changes rather than serving the old one', () => {
    const a = computeForecast(RISING, 1330)!
    const moved = RISING.map((p, i) => (i === 0 ? { ...p, price: p.price * 1.4 } : p))
    const b = computeForecast(moved, 1330)!
    expect(b.volatility).not.toBe(a.volatility)
  })

  it('recomputes when the price it starts from changes', () => {
    const a = computeForecast(RISING, 1330)!
    const b = computeForecast(RISING, 1500)!
    expect(b.from).toBe(1500)
    expect(b.bands[0].mid).not.toBe(a.bands[0].mid)
  })

  it('recomputes the return when only the basis changes', () => {
    const a = computeForecast(RISING, 1330, { basis: 1000 })!
    const b = computeForecast(RISING, 1330, { basis: 2000 })!
    expect(a.basis).toBe(1000)
    expect(b.basis).toBe(2000)
    const roi = (f: typeof a) => f.projections.find((p) => p.years === 1)!.roiMid
    expect(roi(a)).toBeGreaterThan(roi(b))
  })
})

describe('a walk with no trend keeps its median where it started', () => {
  const day = 86_400_000
  const END = Date.UTC(2026, 8, 21)
  const at = (d: number) => new Date(END - d * day).toISOString().slice(0, 10)
  const pts = (pairs: [number, number][]): PricePoint[] =>
    pairs.map(([d, price]) => ({ date: at(d), price, source: 'sale' as const }))

  /** Wobbles, goes nowhere. */
  const FLAT = pts([[400, 2600], [300, 2800], [220, 2650], [140, 2900], [70, 2700], [20, 2900]])

  it('does not drift the median at any horizon', () => {
    // The monthly pool used to carry its own sampling mean, applied to every
    // path alike, so a card with no measured trend was projected to lose or
    // gain a tenth of its value a year out of nothing at all.
    const f = computeForecast(FLAT, 2900)!
    expect(Math.abs(f.driftPerYear)).toBeLessThan(0.05)
    for (const p of f.projections) {
      const drift = Math.abs(Math.log(p.mid / 2900))
      expect(drift).toBeLessThan(0.2)
    }
  })

  it('reports a return near zero rather than a steady decline', () => {
    const f = computeForecast(FLAT, 2900, { basis: 2900 })!
    for (const p of f.projections) expect(Math.abs(p.roiMid)).toBeLessThan(0.05)
  })

  it('agrees with its own one-year band, which is the same question', () => {
    // The bands are walked daily and were always centred correctly; the
    // projections are pooled monthly and were not. The two disagreeing about
    // one card at one horizon is what exposed it.
    const f = computeForecast(FLAT, 2900)!
    const band = f.bands.find((b) => b.horizonDays === 365)!
    const proj = f.projections.find((p) => p.years === 1)!
    expect(Math.abs(Math.log(proj.mid / band.mid))).toBeLessThan(0.08)
    expect(Math.abs(Math.log(proj.low / band.low))).toBeLessThan(0.25)
    expect(Math.abs(Math.log(proj.high / band.high))).toBeLessThan(0.25)
  })
})

describe('sales close together are two buyers, not a violent market', () => {
  const day = 86_400_000
  const END = Date.UTC(2026, 8, 21)
  const at = (d: number) => new Date(END - d * day).toISOString().slice(0, 10)
  const pts = (pairs: [number, number][]): PricePoint[] =>
    pairs.map(([d, price]) => ({ date: at(d), price, source: 'sale' as const }))

  const CLOSE = pts([[400, 2600], [300, 2800], [120, 2700], [60, 3100], [58, 2500], [20, 2900]])
  const SPACED = pts([[400, 2600], [300, 2800], [120, 2700], [75, 3100], [45, 2500], [20, 2900]])

  it('does not read a two-day price difference as a year of volatility', () => {
    const close = computeForecast(CLOSE, 2900)!
    const spaced = computeForecast(SPACED, 2900)!
    // Before the floor these were 82% and 47% from the same six prices.
    expect(Math.abs(close.volatility - spaced.volatility)).toBeLessThan(0.15)
  })

  it('keeps the gap itself, since the floor is only for the scaling', () => {
    const gaps = dailyReturns(CLOSE).map((r) => r.gapDays)
    expect(gaps).toContain(2)
  })

  it('refuses to report a volatility beyond what any card does', () => {
    const chaos = pts([
      [400, 2600], [340, 9200], [338, 900], [280, 7800], [200, 800],
      [130, 9100], [128, 1200], [60, 8400], [20, 2900],
    ])
    const f = computeForecast(chaos, 2900)!
    expect(f.volatility).toBeLessThanOrEqual(MAX_VOLATILITY)
  })
})

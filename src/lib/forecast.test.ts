import { describe, expect, it } from 'vitest'
import {
  MIN_RETURNS_FOR_FORECAST, PRIOR_VOLATILITY, computeForecast, dailyReturns, robustDrift, shrunkVolatility,
} from './forecast'
import type { PricePoint } from './types'

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
    const few = dailyReturns(RISING.slice(0, 4))
    const many = dailyReturns(series(
      Array.from({ length: 30 }, (_, i) => [`2026-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')}`, 1000 + i * 5] as [string, number]),
    ))
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
    expect(f.rationale.join(' ')).toMatch(/too steep/i)
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

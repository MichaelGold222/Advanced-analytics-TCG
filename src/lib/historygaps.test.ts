import { describe, expect, it } from 'vitest'
import { SALES_PER_FETCH, assessHistory, rankGaps, tradeRate } from './historygaps'
import type { PricePoint } from './types'

const NOW = new Date('2026-09-21T00:00:00Z')
const back = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10)
const sale = (d: number, price = 1000): PricePoint => ({ date: back(d), price, source: 'sale' })

const assess = (points: PricePoint[], lastFetched: string | null = back(30)) =>
  assessHistory('k', 'Card', points, undefined, lastFetched, NOW)

describe('a card whose record does not reach back a year', () => {
  // The live shape: five sales in six days on an actively traded slab.
  const FAST = [sale(6), sale(5), sale(3), sale(2), sale(0)]

  it('says the yearly high is the high of six days', () => {
    const g = assess(FAST)
    expect(g.kind).toBe('both')
    expect(Math.round(g.reachDays)).toBe(6)
    expect(g.reason).toMatch(/high of 6/)
  })

  it('leaves a card alone whose sales genuinely span the year', () => {
    const slow = [sale(350), sale(250), sale(150), sale(40)]
    expect(assess(slow).kind).toBe('none')
  })
})

describe('a card that trades faster than it is refreshed', () => {
  it('works out how often a refresh has to happen to keep up', () => {
    // Five sales across twenty days is one every five days, so a fetch that
    // carries five covers about twenty-five.
    const g = assess([sale(20), sale(15), sale(10), sale(5), sale(0)])
    expect(g.safeRefreshDays).toBeGreaterThan(20)
    expect(g.safeRefreshDays).toBeLessThan(30)
  })

  it('counts the sales already lost since the last fetch', () => {
    // One a day, last fetched thirty days ago: a fetch holds five, so about
    // twenty-five are gone for good.
    const daily = Array.from({ length: 10 }, (_, i) => sale(i))
    const g = assess(daily, back(30))
    expect(g.likelyMissed).toBeGreaterThan(20)
    expect(g.reason).toMatch(/lost about \d+ sales/)
  })

  it('flags it even when the record does reach back a year', () => {
    // Deep history and a fast cadence: backfilling would not help this one,
    // only refreshing more often would.
    const deep = [sale(360), sale(200), sale(100), sale(4), sale(3), sale(2), sale(1), sale(0)]
    const g = assess(deep)
    expect(g.kind).toBe('outpaced')
    expect(g.reason).toMatch(/sales start being lost|lost about/)
  })

  it('says nothing about pace when the card barely trades', () => {
    const rare = [sale(360), sale(180)]
    expect(assess(rare).kind).toBe('none')
  })
})

describe('what it refuses to guess', () => {
  it('measures no cadence from a single sale', () => {
    expect(tradeRate([sale(3)])).toBeNull()
    expect(assess([sale(3)]).safeRefreshDays).toBeNull()
  })

  it('counts several sales on one day as a cadence, not a division by zero', () => {
    const rate = tradeRate([sale(0, 100), sale(0, 110), sale(0, 120)])
    expect(rate).not.toBeNull()
    expect(Number.isFinite(rate!)).toBe(true)
  })

  it('says plainly when nothing has been fetched at all', () => {
    const g = assess([])
    expect(g.reason).toMatch(/nothing to read/i)
  })

  it('claims no sales were missed when the card was never fetched', () => {
    expect(assess([sale(2), sale(1)], null).likelyMissed).toBe(0)
  })

  it('ignores typed figures when reading how fast a card trades', () => {
    const typed: PricePoint[] = [
      { date: back(5), price: 900, source: 'user' },
      { date: back(4), price: 950, source: 'user' },
      { date: back(3), price: 980, source: 'user' },
    ]
    expect(tradeRate(typed)).toBeNull()
  })
})

describe('ordering the work', () => {
  it('puts the worst first and leaves out the cards that are fine', () => {
    const gaps = [
      assessHistory('fine', 'Fine', [sale(350), sale(200), sale(60)], undefined, back(2), NOW),
      assessHistory('bad', 'Bad', [sale(6), sale(5), sale(3), sale(2), sale(0)], undefined, back(30), NOW),
      assessHistory('mid', 'Mid', [sale(200), sale(150), sale(100), sale(50)], undefined, back(30), NOW),
    ]
    const ranked = rankGaps(gaps)
    expect(ranked.map((g) => g.key)).not.toContain('fine')
    expect(ranked[0].key).toBe('bad')
  })
})

describe('the fetch ceiling it reasons from', () => {
  it('is the measured five, not a guess', () => {
    expect(SALES_PER_FETCH).toBe(5)
  })
})

import { describe, expect, it } from 'vitest'
import { ALT_CREDITS_PER_LOOKUP, KEEP_YEARS, altSales, parseAltCert, parseAltCerts } from './alt'

/**
 * The shape run 2 of the Alt check returned for cert 77865285 — the 2019
 * Japanese SM promo Card Ladder could not reach at all.
 */
const LIVE = {
  status: 'success',
  data: {
    alt_value: 612.5,
    population: 7856,
    sales_count: 1422,
    cert: { cert_number: '77865285', grading_company: 'PSA', grade_number: 10 },
    asset: { id: 'abc123' },
    sales: [
      { id: 1, date: '2026-09-19T00:00:00Z', price: 525, auction_house: 'eBay', grade_number: 10, listing_url: 'https://ebay.com/itm/1' },
      { id: 2, date: '2026-03-02T12:30:00Z', price: 1000, auction_house: 'Goldin', grade_number: 10 },
      { id: 3, date: '2025-11-08T00:00:00Z', price: 198, auction_house: 'eBay', grade_number: 10 },
      { id: 4, date: '2020-09-13T00:00:00Z', price: 6, auction_house: 'eBay', grade_number: 10 },
    ],
  },
}

const NOW = new Date('2026-09-22T00:00:00Z')
const read = (cert = '77865285') => parseAltCert(LIVE, cert, NOW)!

describe('what Alt gives that nothing else could', () => {
  it('reads the dated sales for a cert with no card id anywhere', () => {
    const c = read()
    expect(c.cert).toBe('77865285')
    expect(c.sales.map((s) => s.date)).toEqual([
      '2025-11-08', '2026-03-02', '2026-09-19',
    ])
  })

  it('gives the real high, not a floor on one', () => {
    // Card Ladder aggregates into {date, price, count}, so an averaged point
    // hides its extremes. These are individual sales.
    const prices = read().sales.map((s) => s.price)
    expect(Math.max(...prices)).toBe(1000)
  })

  it('counts them as completed sales, since that is what they are', () => {
    expect(read('').sales.every((s) => s.source === 'sale')).toBe(true)
  })

  it('keeps the auction house as the venue', () => {
    const byDate = new Map(read('').sales.map((s) => [s.date, s]))
    expect(byDate.get('2026-03-02')!.venue).toBe('Goldin')
  })

  it('carries the population, which no price series contains', () => {
    expect(read('').population).toBe(7856)
  })

  it('reports what Alt holds even when it kept less', () => {
    // 1,422 on record against 3 kept must read as a trim, not a short answer.
    const c = read('')
    expect(c.salesCount).toBe(1422)
    expect(c.sales.length).toBeLessThan(c.salesCount!)
  })

  it('is priced at the measured two credits a certificate', () => {
    expect(ALT_CREDITS_PER_LOOKUP).toBe(2)
  })
})

describe('keeping two years rather than six', () => {
  // Alt has no date parameter, so this saves no credits. It saves the browser
  // from ~45,000 points across the collection, walked by every analysis.
  it('drops a sale older than the window', () => {
    const old = altSales({ sales: [{ date: '2020-09-13T00:00:00Z', price: 6 }] }, NOW)
    expect(old).toHaveLength(0)
  })

  it('keeps one just inside it', () => {
    const inside = altSales({ sales: [{ date: '2025-01-01T00:00:00Z', price: 300 }] }, NOW)
    expect(inside).toHaveLength(1)
  })

  it('keeps the window at the longest span anything reports', () => {
    expect(KEEP_YEARS).toBe(2)
  })
})

describe('rows it will not take', () => {
  const of = (sales: unknown[]) => altSales({ sales })

  it('skips a sale with no price or no date', () => {
    expect(of([{ date: '2026-01-01' }, { price: 100 }, { date: '', price: 100 }])).toHaveLength(0)
  })

  it('skips a zero or negative price', () => {
    expect(of([{ date: '2026-01-01', price: 0 }, { date: '2026-01-02', price: -5 }])).toHaveLength(0)
  })

  it('collapses an exact duplicate', () => {
    expect(of([
      { date: '2026-01-01T09:00:00Z', price: 100 },
      { date: '2026-01-01T17:00:00Z', price: 100 },
    ])).toHaveLength(1)
  })

  it('keeps two sales on one day at different prices', () => {
    expect(of([
      { date: '2026-01-01', price: 100 },
      { date: '2026-01-01', price: 140 },
    ])).toHaveLength(2)
  })

  it('returns nothing rather than throwing on a shape it cannot read', () => {
    expect(altSales(null)).toEqual([])
    expect(altSales({})).toEqual([])
    expect(altSales({ sales: 'nope' })).toEqual([])
    expect(parseAltCert({ data: null }, '')).toBeNull()
  })
})

describe('the bulk response, whose shape is not yet measured', () => {
  // lookup_certs takes cert_numbers (plural, required) but has never been
  // called, so the reader accepts the plausible shapes rather than assuming.
  const one = LIVE.data

  it('reads a plain array of records', () => {
    expect(parseAltCerts({ data: [one] }, ['77865285'])).toHaveLength(1)
  })

  it('reads a list nested under any key', () => {
    expect(parseAltCerts({ data: { results: [one] } }, ['77865285'])).toHaveLength(1)
  })

  it('reads a map of cert to record, taking the cert from the key', () => {
    const out = parseAltCerts({ data: { '99999999': { sales: one.sales } } }, [])
    expect(out).toHaveLength(1)
    expect(out[0].cert).toBe('99999999')
  })

  it('reads a single record answered without a list', () => {
    expect(parseAltCerts({ data: one }, ['77865285'])).toHaveLength(1)
  })

  it('does not return the same cert twice', () => {
    expect(parseAltCerts({ data: [one, one] }, ['77865285', '77865285'])).toHaveLength(1)
  })

  it('returns nothing on a shape it cannot read, rather than throwing', () => {
    expect(parseAltCerts({ data: 'nope' }, [])).toEqual([])
    expect(parseAltCerts({}, [])).toEqual([])
  })
})

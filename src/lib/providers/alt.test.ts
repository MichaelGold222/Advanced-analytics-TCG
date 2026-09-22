import { describe, expect, it } from 'vitest'
import { ALT_CREDITS_PER_LOOKUP, KEEP_YEARS, altSales, parseAltCert, parseAltCerts } from './alt'

/**
 * The shape run 2 of the Alt check returned for cert 77865285 — the 2019
 * Japanese SM promo Card Ladder could not reach at all.
 */
const LIVE_INNER = {
  cert: { cert_number: '77865285', grading_company: 'PSA', grade_number: '10.0' },
  asset: {
    asset_id: '54decb69-a898-4549-ba68-dceabe7dcfae',
    name: '2019 Pokemon Sun and Moon Promo Japanese My251 Pokemon Center Midsummer Shining Grand Plan Playing In the Sea Pikachu #392SMP',
    subject: 'Playing In the Sea Pikachu',
    card_number: '392SMP',
    image_url: 'https://alt-images.b-cdn.net/external/ebay/live/206569247952_0.jpg',
  },
  alt_value: { current: 470.59320623224426, confidence_metric: 100.0 },
  // Every grade, not a number — 59 entries on the real card.
  population: [
    { grading_company: 'PSA', grade_number: 9.0, count: 12000 },
    { grading_company: 'PSA', grade_number: 10.0, count: 7905 },
    { grading_company: 'BGS', grade_number: 10.0, count: 40 },
  ],
  sales: [
    { id: 'a1', date: '2026-09-19', price: 525, auction_house: 'PWCC Fixed Price', auction_type: 'BEST_OFFER', grade_number: 10.0, subject_to_change: true },
    { id: 'a2', date: '2026-03-02', price: 1000, auction_house: 'Goldin', grade_number: 10.0 },
    { id: 'a3', date: '2025-11-08', price: 198, auction_house: 'eBay', grade_number: 10.0 },
    { id: 'a4', date: '2020-09-13', price: 6, auction_house: 'eBay', grade_number: 10.0 },
  ],
  sales_count: 1422,
}

/** `lookup_cert` (singular) answers with the payload under one `data`. */
const LIVE = { status: 'success', data: LIVE_INNER }

/** `lookup_certs` wraps each record again — the shape the first reader missed. */
const LIVE_BULK = {
  status: 'success',
  data: {
    results: [
      { cert_number: '77865285', status: 'found', error: null, data: LIVE_INNER },
      { cert_number: '156418165', status: 'found', error: null, data: { ...LIVE_INNER, sales_count: 12 } },
    ],
    requested_count: 2, found_count: 2, not_found_count: 0, error_count: 0,
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

  it('carries the population at this grade, which no price series contains', () => {
    expect(read().population).toBe(7905)
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

describe('the bulk response, as lookup_certs actually returns it', () => {
  // Measured in run 3. Each result wraps its payload in a SECOND `data`
  // object; the first reader looked for list items carrying `sales` directly,
  // walked past 1,422 sales a card, and reported "nothing for 32
  // certificates" after calls that had every one succeeded.
  it('reads both records out of data.results', () => {
    const out = parseAltCerts(LIVE_BULK, ['77865285', '156418165'], NOW)
    expect(out.map((c) => c.cert)).toEqual(['77865285', '156418165'])
    expect(out[0].sales.length).toBeGreaterThan(0)
  })

  it('takes the population at THIS grade, not the first or the total', () => {
    // 59 grades come back for a real card; PSA 10 is the one that matters.
    expect(parseAltCerts(LIVE_BULK, [], NOW)[0].population).toBe(7905)
  })

  it('reads alt_value out of its object rather than expecting a number', () => {
    expect(parseAltCerts(LIVE_BULK, [], NOW)[0].altValue).toBeCloseTo(470.59, 1)
  })

  it('keeps the card name and picture, both free in the same response', () => {
    const c = parseAltCerts(LIVE_BULK, [], NOW)[0]
    expect(c.name).toContain('Playing In the Sea Pikachu')
    expect(c.image).toContain('alt-images')
  })

  it('leaves out a certificate Alt reports as not found', () => {
    const body = { data: { results: [
      { cert_number: '111', status: 'not_found', error: 'no match', data: null },
      { cert_number: '222', status: 'found', data: LIVE_INNER },
    ] } }
    expect(parseAltCerts(body, ['111', '222'], NOW).map((c) => c.cert)).toEqual(['222'])
  })

  it('still reads the singular lookup_cert shape', () => {
    expect(parseAltCerts({ data: LIVE_INNER }, ['77865285'], NOW)).toHaveLength(1)
  })

  it('does not return the same cert twice', () => {
    const body = { data: { results: [
      { cert_number: '77865285', status: 'found', data: LIVE_INNER },
      { cert_number: '77865285', status: 'found', data: LIVE_INNER },
    ] } }
    expect(parseAltCerts(body, [], NOW)).toHaveLength(1)
  })

  it('returns nothing on a shape it cannot read, rather than throwing', () => {
    expect(parseAltCerts({ data: 'nope' }, [], NOW)).toEqual([])
    expect(parseAltCerts({}, [], NOW)).toEqual([])
    expect(parseAltCerts(null, [], NOW)).toEqual([])
  })
})

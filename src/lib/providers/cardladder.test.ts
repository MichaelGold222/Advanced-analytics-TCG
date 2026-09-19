import { describe, expect, it } from 'vitest'
import {
  MAX_CERTS_PER_CALL, batchCerts, buildFeed, isSupportedGrader, parseBulkResponse, salesToPricePoints,
} from './cardladder'
import { computeFmv } from '../analytics'

/** A verbatim response from the live API, used as the fixture. */
const LIVE_BULK = {
  status: 'success',
  data: {
    results: [
      {
        cert_number: '93083876',
        grading_company: 'PSA',
        last_sale_price: 21000.0,
        cl_value: 21911.69,
        recent_sales: [
          { date: '2026-09-07T03:19:00.000Z', price: 21000.0, url: 'https://www.fanaticscollect.com/weekly/8b379e50', type: 'Auction' },
          { date: '2026-08-24T03:25:00.000Z', price: 21600.0, url: 'https://www.fanaticscollect.com/weekly/947de64a', type: 'Auction' },
          { date: '2026-07-20T00:51:00.000Z', price: 11200.0, url: 'https://www.ebay.com/itm/287456192405', type: 'Auction' },
          { date: '2026-06-15T03:22:00.000Z', price: 16200.0, url: 'https://www.fanaticscollect.com/weekly/593e73d6', type: 'Auction' },
          { date: '2026-03-16T03:12:00.000Z', price: 6300.0, url: 'https://www.fanaticscollect.com/weekly/bab98724', type: 'Auction' },
        ],
      },
    ],
    errors: [],
    total: 1,
  },
}

describe('salesToPricePoints', () => {
  it('reads the live sale records as completed sales', () => {
    const points = salesToPricePoints(LIVE_BULK.data.results[0].recent_sales)
    expect(points).toHaveLength(5)
    expect(points.every((p) => p.source === 'sale')).toBe(true)
  })

  it('normalizes ISO timestamps to dates and sorts oldest first', () => {
    const points = salesToPricePoints(LIVE_BULK.data.results[0].recent_sales)
    expect(points[0]).toEqual({ date: '2026-03-16', price: 6300, source: 'sale' })
    expect(points.at(-1)).toEqual({ date: '2026-09-07', price: 21000, source: 'sale' })
  })

  it('drops records it cannot use rather than inventing values', () => {
    expect(salesToPricePoints([
      { date: '2026-09-07T00:00:00Z', price: 100 },
      { date: '2026-09-08T00:00:00Z' },
      { price: 200 },
      { date: 'not a date', price: 300 },
      { date: '2026-09-09T00:00:00Z', price: 0 },
      { date: '2026-09-10T00:00:00Z', price: -5 },
    ])).toEqual([{ date: '2026-09-07', price: 100, source: 'sale' }])
  })

  it('collapses the same sale appearing twice', () => {
    const one = { date: '2026-09-07T03:19:00.000Z', price: 21000 }
    expect(salesToPricePoints([one, { ...one }])).toHaveLength(1)
  })

  it('handles a missing or malformed list', () => {
    expect(salesToPricePoints(undefined)).toEqual([])
    expect(salesToPricePoints(null as never)).toEqual([])
  })
})

describe('parseBulkResponse', () => {
  it('reads the live response', () => {
    const [entry] = parseBulkResponse(LIVE_BULK)
    expect(entry.cert).toBe('93083876')
    expect(entry.grader).toBe('PSA')
    expect(entry.clValue).toBe(21911.69)
    expect(entry.lastSalePrice).toBe(21000)
    expect(entry.points).toHaveLength(5)
  })

  it('survives an empty or unexpected body', () => {
    expect(parseBulkResponse({})).toEqual([])
    expect(parseBulkResponse({ data: { results: [] } })).toEqual([])
    expect(parseBulkResponse(null)).toEqual([])
    expect(parseBulkResponse('nonsense')).toEqual([])
  })

  it('skips a result with no cert number', () => {
    expect(parseBulkResponse({ data: { results: [{ cl_value: 10 }] } })).toEqual([])
  })
})

describe('the valuation those sales feed', () => {
  it('produces the median of the five real sales', () => {
    const [entry] = parseBulkResponse(LIVE_BULK)
    const fmv = computeFmv({ key: 'c', points: entry.points }, new Date('2026-09-19T00:00:00Z'))
    // 6300, 11200, 16200, 21000, 21600 -> median 16200
    expect(fmv.fmv).toBe(16200)
    expect(fmv.sampleSize).toBe(5)
    expect(fmv.rationale.join(' ')).toMatch(/median of the last 5 completed sales/i)
  })

  it('does not call a 3.4x spread high confidence', () => {
    const [entry] = parseBulkResponse(LIVE_BULK)
    const fmv = computeFmv({ key: 'c', points: entry.points }, new Date('2026-09-19T00:00:00Z'))
    expect(fmv.confidence).not.toBe('high')
    expect(fmv.rationale.join(' ')).toMatch(/varied widely/i)
  })
})

describe('batching', () => {
  const certs = Array.from({ length: 450 }, (_, i) => ({ cert_number: String(i), grading_company: 'PSA' as const }))

  it('splits at the documented limit of 200 per call', () => {
    const batches = batchCerts(certs)
    expect(batches.map((b) => b.length)).toEqual([200, 200, 50])
    expect(MAX_CERTS_PER_CALL).toBe(200)
  })

  it('keeps every cert exactly once', () => {
    expect(batchCerts(certs).flat()).toHaveLength(450)
  })

  it('a whole 85-card collection fits in one call', () => {
    expect(batchCerts(certs.slice(0, 85))).toHaveLength(1)
  })

  it('handles an empty list', () => {
    expect(batchCerts([])).toEqual([])
  })
})

describe('grader support', () => {
  it('accepts the four the endpoint takes, case-insensitively', () => {
    for (const g of ['PSA', 'BGS', 'CGC', 'SGC', 'psa']) expect(isSupportedGrader(g)).toBe(true)
  })

  it('rejects the rest, which the endpoint would refuse anyway', () => {
    for (const g of ['ACE', 'TAG', '', null, undefined]) expect(isSupportedGrader(g)).toBe(false)
  })
})

describe('buildFeed', () => {
  it('keys the feed by cert and keeps errors alongside', () => {
    const feed = buildFeed(parseBulkResponse(LIVE_BULK), [{ cert: '111', message: 'not found' }])
    expect(Object.keys(feed.byCert)).toEqual(['93083876'])
    expect(feed.byCert['93083876'].sales).toHaveLength(5)
    expect(feed.byCert['93083876'].clValue).toBe(21911.69)
    expect(feed.errors).toEqual([{ cert: '111', message: 'not found' }])
    expect(Date.parse(feed.fetchedAt)).not.toBeNaN()
  })
})

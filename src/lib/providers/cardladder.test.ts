import { describe, expect, it } from 'vitest'
import {
  CALL_OVERHEAD_MS, CREDITS_PER_CALL, FETCH_CONCURRENCY, MAX_CERTS_PER_CALL, MIN_BATCH_SIZE, MS_PER_CERT,
  batchCerts, buildFeed, estimateFetch, isSupportedGrader, parseBulkResponse, planBatchSize,
  salesToPricePoints,
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

  it('splits into as many calls as run at once, so it is one wave', () => {
    const batches = batchCerts(certs)
    expect(batches).toHaveLength(FETCH_CONCURRENCY)
  })

  it('never exceeds the endpoint ceiling, whatever size is asked for', () => {
    expect(batchCerts(certs, 1000)[0]).toHaveLength(MAX_CERTS_PER_CALL)
  })

  it('treats a nonsense batch size as one per call rather than looping forever', () => {
    expect(batchCerts(certs.slice(0, 3), 0).map((b) => b.length)).toEqual([1, 1, 1])
  })

  it('keeps every cert exactly once', () => {
    expect(batchCerts(certs).flat()).toHaveLength(450)
  })

  it('an 85-card collection is one wave of short calls, not one long call', () => {
    const batches = batchCerts(certs.slice(0, 85))
    expect(batches.length).toBeLessThanOrEqual(FETCH_CONCURRENCY)
    expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(15)
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

describe('estimating the wait', () => {
  it('is measured against the live endpoint, not guessed', () => {
    // Observed: 1 cert 2.5s, 4 certs 4.5s, 12 certs 9.0s in a single call.
    const oneCall = (n: number) => CALL_OVERHEAD_MS + n * MS_PER_CERT
    expect(oneCall(1)).toBeCloseTo(2600, -3)
    expect(oneCall(4)).toBeCloseTo(4400, -3)
    expect(oneCall(12)).toBeCloseTo(9200, -3)
  })

  it('counts waves rather than calls, since calls overlap', () => {
    // Six calls three at a time is two waves, not six.
    const { ms, calls } = estimateFetch(25 * 6, 25, 3)
    expect(calls).toBe(6)
    expect(ms).toBe(2 * (CALL_OVERHEAD_MS + 25 * MS_PER_CERT))
  })

  it('an 85-slab collection is a wait of seconds, not minutes', () => {
    // What the old single 200-cert call made of it: over two minutes.
    expect(estimateFetch(85).ms).toBeLessThan(30_000)
  })

  it('charges per call, so more certs in a call is cheaper', () => {
    expect(estimateFetch(50, 25).credits).toBe(2 * CREDITS_PER_CALL)
    expect(estimateFetch(50, 50).credits).toBe(CREDITS_PER_CALL)
  })

  it('promises nothing for an empty list', () => {
    expect(estimateFetch(0)).toEqual({ ms: 0, credits: 0, calls: 0 })
  })
})

describe('planning the calls', () => {
  it('keeps a collection to a single wave', () => {
    for (const n of [30, 90, 200, 400, 1200]) {
      expect(Math.ceil(n / planBatchSize(n))).toBeLessThanOrEqual(FETCH_CONCURRENCY)
    }
  })

  it('does not buy calls a small collection has no use for', () => {
    expect(planBatchSize(8)).toBe(MIN_BATCH_SIZE)
    expect(batchCerts(Array.from({ length: 8 }, (_, i) => ({
      cert_number: String(i), grading_company: 'PSA' as const,
    })))).toHaveLength(1)
  })

  it('never asks for more than the endpoint accepts', () => {
    expect(planBatchSize(100_000)).toBe(MAX_CERTS_PER_CALL)
  })

  it('takes one wave whether it is 90 slabs or 400, so cost stays bounded', () => {
    const ceiling = FETCH_CONCURRENCY * CREDITS_PER_CALL
    for (const n of [90, 200, 400]) {
      expect(estimateFetch(n).credits).toBeLessThanOrEqual(ceiling)
      expect(estimateFetch(n).ms).toBeLessThan(150_000)
    }
  })

  it('prices 90 slabs in well under a minute', () => {
    expect(estimateFetch(90).ms).toBeLessThan(20_000)
  })

  it('handles an empty collection without dividing by zero', () => {
    expect(planBatchSize(0)).toBe(MIN_BATCH_SIZE)
  })
})

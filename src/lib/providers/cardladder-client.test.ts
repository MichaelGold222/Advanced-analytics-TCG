/**
 * @vitest-environment happy-dom
 *
 * The client keeps the key in localStorage, so these need a browser-like
 * environment rather than bare Node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ParseError, fetchCertPrices, getParseKey, setParseKey } from './cardladder-client'

/** Parse's real envelope, as observed live. */
function bulkBody(certs: { cert_number: string }[]) {
  return {
    status: 'success',
    data: {
      results: certs.map((c, i) => ({
        cert_number: c.cert_number,
        grading_company: 'PSA',
        last_sale_price: 1000 + i,
        cl_value: 1100 + i,
        recent_sales: [
          { date: '2026-09-07T03:19:00.000Z', price: 1000 + i, type: 'Auction' },
          { date: '2026-08-24T03:25:00.000Z', price: 1050 + i, type: 'Auction' },
          { date: '2026-07-20T00:51:00.000Z', price: 980 + i, type: 'Auction' },
        ],
      })),
      errors: [],
      total: certs.length,
    },
  }
}

interface Call { url: string; body?: unknown }

function stubParse(opts: { bulkStatus?: number; missing?: string[]; headers?: Record<string, string> } = {}) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url: String(url), body })

    const make = (status: number, payload: unknown, headers: Record<string, string> = {}) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (h: string) => headers[h] ?? null },
        json: async () => payload,
      }) as unknown as Response

    if (String(url).includes('/dispatch/tasks/')) {
      return make(200, { result_scraper_id: 'scraper-abc', id: 'task-xyz' })
    }
    if (String(url).includes('/dispatch/tasks')) {
      return make(200, { tasks: [{ id: 'task-xyz', url: 'https://cardladder.com/', status: 'completed' }] })
    }
    if (String(url).includes('get_cert_values_bulk')) {
      if (opts.bulkStatus && opts.bulkStatus !== 200) return make(opts.bulkStatus, {})
      const asked = (body as { certs: { cert_number: string }[] }).certs
      const kept = asked.filter((c) => !opts.missing?.includes(c.cert_number))
      return make(200, bulkBody(kept), opts.headers ?? {})
    }
    return make(404, {})
  })
  return calls
}

beforeEach(() => {
  localStorage.clear()
  setParseKey('')
})
afterEach(() => vi.unstubAllGlobals())

describe('the key', () => {
  it('round-trips and clears', () => {
    setParseKey('pmx_test')
    expect(getParseKey()).toBe('pmx_test')
    setParseKey('')
    expect(getParseKey()).toBe('')
  })
})

describe('fetchCertPrices', () => {
  const certs = [
    { cert_number: '111', grading_company: 'PSA' as const },
    { cert_number: '222', grading_company: 'PSA' as const },
  ]

  it('resolves the callable scraper, not the task id', async () => {
    const calls = stubParse()
    await fetchCertPrices(certs, { key: 'k' })
    // result_scraper_id, not the task's own id: executing with the task id 404s.
    expect(calls.at(-1)!.url).toContain('/scraper/scraper-abc/get_cert_values_bulk')
  })

  it('returns sold comps as price points', async () => {
    stubParse()
    const { prices } = await fetchCertPrices(certs, { key: 'k' })
    expect(prices).toHaveLength(2)
    expect(prices[0].points).toHaveLength(3)
    expect(prices[0].points.every((p) => p.source === 'sale')).toBe(true)
  })

  it('sends every cert in one call when they fit', async () => {
    const calls = stubParse()
    await fetchCertPrices(certs, { key: 'k' })
    const bulk = calls.filter((c) => c.url.includes('get_cert_values_bulk'))
    expect(bulk).toHaveLength(1)
    expect((bulk[0].body as { certs: unknown[] }).certs).toHaveLength(2)
  })

  it('splits past the 200-cert limit', async () => {
    const calls = stubParse()
    const many = Array.from({ length: 250 }, (_, i) => ({ cert_number: String(i), grading_company: 'PSA' as const }))
    await fetchCertPrices(many, { key: 'k' })
    expect(calls.filter((c) => c.url.includes('get_cert_values_bulk'))).toHaveLength(2)
  })

  it('reports certs the upstream simply omitted', async () => {
    stubParse({ missing: ['222'] })
    const { prices, unmatched } = await fetchCertPrices(certs, { key: 'k' })
    expect(prices).toHaveLength(1)
    expect(unmatched).toEqual(['222'])
  })

  it('reads the credit counters Parse exposes', async () => {
    stubParse({ headers: { 'X-Credits-Charged': '2', 'X-Credits-Remaining': '4998', 'X-Credits-Limit': '5000' } })
    const { usage } = await fetchCertPrices(certs, { key: 'k' })
    expect(usage).toMatchObject({ creditsCharged: 2, creditsRemaining: 4998, creditsLimit: 5000 })
  })

  it('reports progress as batches complete', async () => {
    stubParse()
    const seen: number[] = []
    await fetchCertPrices(certs, { key: 'k', onProgress: (done) => seen.push(done) })
    expect(seen).toEqual([2])
  })

  it('does nothing, and charges nothing, for an empty list', async () => {
    const calls = stubParse()
    expect(await fetchCertPrices([], { key: 'k' })).toEqual({ prices: [], unmatched: [], usage: null })
    expect(calls).toHaveLength(0)
  })

  it('says plainly when the key is refused', async () => {
    stubParse({ bulkStatus: 401 })
    await expect(fetchCertPrices(certs, { key: 'bad' })).rejects.toThrow(/key was refused/i)
  })

  it('says plainly when credits run out', async () => {
    stubParse({ bulkStatus: 429 })
    await expect(fetchCertPrices(certs, { key: 'k' })).rejects.toThrow(/credits or rate limited/i)
  })

  it('distinguishes an unreachable API from a refusal', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch') })
    const err = await fetchCertPrices(certs, { key: 'k' }).catch((e) => e)
    expect(err).toBeInstanceOf(ParseError)
    expect((err as ParseError).status).toBe(0)
  })
})

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
      if (opts.bulkStatus && opts.bulkStatus !== 200) return make(opts.bulkStatus, {}, opts.headers ?? {})
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

  it('splits a large collection into calls that report progress along the way', async () => {
    const calls = stubParse()
    const many = Array.from({ length: 250 }, (_, i) => ({ cert_number: String(i), grading_company: 'PSA' as const }))
    const seen: number[] = []
    await fetchCertPrices(many, { key: 'k', onProgress: (done) => seen.push(done) })
    const bulk = calls.filter((c) => c.url.includes('get_cert_values_bulk'))
    expect(bulk.length).toBeGreaterThan(1)
    // The whole point: the counter moves before the end, not only at it.
    expect(seen).toHaveLength(bulk.length)
    expect(seen.at(-1)).toBe(250)
  })

  it('prices every cert exactly once across those calls', async () => {
    const calls = stubParse()
    const many = Array.from({ length: 250 }, (_, i) => ({ cert_number: String(i), grading_company: 'PSA' as const }))
    const { prices } = await fetchCertPrices(many, { key: 'k' })
    const sent = calls
      .filter((c) => c.url.includes('get_cert_values_bulk'))
      .flatMap((c) => (c.body as { certs: { cert_number: string }[] }).certs.map((x) => x.cert_number))
    expect(new Set(sent).size).toBe(250)
    expect(prices).toHaveLength(250)
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
    expect(await fetchCertPrices([], { key: 'k' }))
      .toEqual({ prices: [], unmatched: [], failed: [], usage: null, partialError: null })
    expect(calls).toHaveLength(0)
  })

  it('says plainly when the key is refused', async () => {
    stubParse({ bulkStatus: 401 })
    await expect(fetchCertPrices(certs, { key: 'bad' })).rejects.toThrow(/key was refused/i)
  })

  it('says plainly when credits run out', async () => {
    stubParse({ bulkStatus: 429, headers: { 'X-Credits-Remaining': '0' } })
    await expect(fetchCertPrices(certs, { key: 'k' })).rejects.toThrow(/out of credits/i)
  })

  it('waits out a spent burst instead of calling it an empty balance', async () => {
    // A 429 with no credit header is a rate limit. Number(null) is 0, so this
    // is exactly the case that would otherwise be misread as no credits left.
    vi.useFakeTimers()
    try {
      const calls = stubParse({ bulkStatus: 429, headers: { 'Retry-After': '1' } })
      const run = fetchCertPrices(certs, { key: 'k' }).catch((e: Error) => e)
      await vi.advanceTimersByTimeAsync(10_000)
      const err = await run
      expect((err as Error).message).toMatch(/rate limited/i)
      // It retried rather than giving up on the first refusal.
      expect(calls.filter((c) => c.url.includes('get_cert_values_bulk')).length).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says plainly when the key is refused', async () => {
    stubParse({ bulkStatus: 401 })
    await expect(fetchCertPrices(certs, { key: 'bad' })).rejects.toThrow(/key was refused/i)
  })

  it('says plainly when credits run out', async () => {
    stubParse({ bulkStatus: 429, headers: { 'X-Credits-Remaining': '0' } })
    await expect(fetchCertPrices(certs, { key: 'k' })).rejects.toThrow(/out of credits/i)
  })

  it('waits out a spent burst instead of calling it an empty balance', async () => {
    // A 429 with no credit header is a rate limit. Number(null) is 0, so this
    // is exactly the case that would otherwise be misread as no credits left.
    vi.useFakeTimers()
    try {
      const calls = stubParse({ bulkStatus: 429, headers: { 'Retry-After': '1' } })
      const run = fetchCertPrices(certs, { key: 'k' }).catch((e: Error) => e)
      await vi.advanceTimersByTimeAsync(10_000)
      const err = await run
      expect((err as Error).message).toMatch(/rate limited/i)
      // It retried rather than giving up on the first refusal.
      expect(calls.filter((c) => c.url.includes('get_cert_values_bulk')).length).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('distinguishes an unreachable API from a refusal', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch') })
    const err = await fetchCertPrices(certs, { key: 'k' }).catch((e) => e)
    expect(err).toBeInstanceOf(ParseError)
    expect((err as ParseError).status).toBe(0)
  })
})

describe('a server that is having a bad moment', () => {
  const twoCerts = [
    { cert_number: '111', grading_company: 'PSA' as const },
    { cert_number: '222', grading_company: 'PSA' as const },
  ]

  /** Fails the bulk call `failTimes` times, then answers normally. */
  function flaky(failTimes: number, status = 503) {
    let seen = 0
    const make = (code: number, payload: unknown) =>
      ({ ok: code >= 200 && code < 300, status: code, headers: { get: () => null }, json: async () => payload }) as unknown as Response
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).includes('/dispatch/tasks/')) return make(200, { result_scraper_id: 's' })
      if (String(url).includes('/dispatch/tasks')) return make(200, { tasks: [{ id: 't', url: 'https://cardladder.com/' }] })
      if (seen++ < failTimes) return make(status, {})
      const body = init?.body ? JSON.parse(String(init.body)) : { certs: [] }
      return make(200, bulkBody(body.certs))
    })
  }

  it('retries a 503 instead of losing the slabs in that call', async () => {
    vi.useFakeTimers()
    try {
      flaky(2)
      const run = fetchCertPrices(twoCerts, { key: 'k' })
      await vi.advanceTimersByTimeAsync(30_000)
      const { prices, failed } = await run
      expect(prices).toHaveLength(2)
      expect(failed).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not call a cert unmatched because the server never answered', async () => {
    // "No match" tells someone to check their certificate numbers. A 503 is
    // not a verdict on the numbers.
    vi.useFakeTimers()
    try {
      flaky(99)
      const run = fetchCertPrices(twoCerts, { key: 'k' }).catch((e: Error) => e)
      await vi.advanceTimersByTimeAsync(60_000)
      const out = await run
      expect(out).toBeInstanceOf(ParseError)
      expect((out as ParseError).status).toBe(503)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps what it priced and says the rest will be retried', async () => {
    vi.useFakeTimers()
    try {
      // First batch answers; the second fails every attempt.
      let n = 0
      const make = (code: number, payload: unknown) =>
        ({ ok: code >= 200 && code < 300, status: code, headers: { get: () => null }, json: async () => payload }) as unknown as Response
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        if (String(url).includes('/dispatch/tasks/')) return make(200, { result_scraper_id: 's' })
        if (String(url).includes('/dispatch/tasks')) return make(200, { tasks: [{ id: 't', url: 'https://cardladder.com/' }] })
        const body = init?.body ? JSON.parse(String(init.body)) : { certs: [] }
        if (++n > 1) return make(503, {})
        return make(200, bulkBody(body.certs))
      })
      const many = Array.from({ length: 40 }, (_, i) => ({ cert_number: String(i), grading_company: 'PSA' as const }))
      const run = fetchCertPrices(many, { key: 'k' })
      await vi.advanceTimersByTimeAsync(120_000)
      const { prices, failed, unmatched, partialError } = await run
      expect(prices.length).toBeGreaterThan(0)
      expect(failed.length).toBeGreaterThan(0)
      expect(unmatched).toEqual([])
      expect(partialError).toMatch(/could not be reached and will be retried/i)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a call that hangs', () => {
  it('gives up on it and retries rather than holding the worker forever', async () => {
    vi.useFakeTimers()
    try {
      let attempts = 0
      const make = (payload: unknown) =>
        ({ ok: true, status: 200, headers: { get: () => null }, json: async () => payload }) as unknown as Response
      vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
        if (String(url).includes('/dispatch/tasks/')) return Promise.resolve(make({ result_scraper_id: 's' }))
        if (String(url).includes('/dispatch/tasks')) {
          return Promise.resolve(make({ tasks: [{ id: 't', url: 'https://cardladder.com/' }] }))
        }
        // The first bulk call never settles until it is aborted.
        if (attempts++ === 0) {
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Timed out', 'TimeoutError'))
            })
          })
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as { certs: { cert_number: string }[] }
        return Promise.resolve(make(bulkBody(body.certs)))
      })

      const run = fetchCertPrices(
        [{ cert_number: '111', grading_company: 'PSA' }], { key: 'k' },
      )
      await vi.advanceTimersByTimeAsync(200_000)
      const { prices, failed } = await run
      expect(attempts).toBeGreaterThan(1)
      expect(prices).toHaveLength(1)
      expect(failed).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('still honours a cancellation from the caller', async () => {
    const ac = new AbortController()
    let bulkStarted: () => void
    const inFlight = new Promise<void>((resolve) => { bulkStarted = resolve })

    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const make = (payload: unknown) =>
        ({ ok: true, status: 200, headers: { get: () => null }, json: async () => payload }) as unknown as Response
      if (String(url).includes('/dispatch/tasks/')) return Promise.resolve(make({ result_scraper_id: 's' }))
      if (String(url).includes('/dispatch/tasks')) {
        return Promise.resolve(make({ tasks: [{ id: 't', url: 'https://cardladder.com/' }] }))
      }
      bulkStarted()
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    })

    const run = fetchCertPrices([{ cert_number: '111', grading_company: 'PSA' }], { key: 'k', signal: ac.signal })
    // Abort only once the call is actually in flight; a signal that is already
    // aborted never fires a listener added afterwards.
    await inFlight
    ac.abort()
    await expect(run).rejects.toThrow()
  })
})

describe('telling the three kinds of 429 apart', () => {
  const one = [{ cert_number: '111', grading_company: 'PSA' as const }]

  function stub(headers: Record<string, string>) {
    const make = (status: number, payload: unknown, h: Record<string, string> = {}) =>
      ({ ok: status >= 200 && status < 300, status, headers: { get: (k: string) => h[k] ?? null }, json: async () => payload }) as unknown as Response
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/dispatch/tasks/')) return make(200, { result_scraper_id: 's' })
      if (String(url).includes('/dispatch/tasks')) return make(200, { tasks: [{ id: 't', url: 'https://cardladder.com/' }] })
      return make(429, {}, headers)
    })
  }

  it('says the day is spent, and when it comes back', async () => {
    stub({
      'X-Credits-Remaining': '150',
      'X-RateLimit-Daily-Remaining': '0',
      'X-RateLimit-Daily-Limit': '100',
      'X-RateLimit-Daily-Reset': '21600',
    })
    await expect(fetchCertPrices(one, { key: 'k' })).rejects.toThrow(/allowance is used up \(100 a day\).*6 hours/i)
  })

  it('keeps an empty balance separate from a spent day', async () => {
    stub({ 'X-Credits-Remaining': '0', 'X-RateLimit-Daily-Remaining': '50' })
    await expect(fetchCertPrices(one, { key: 'k' })).rejects.toThrow(/out of credits/i)
  })

  it('treats anything else as a burst worth waiting out', async () => {
    vi.useFakeTimers()
    try {
      stub({ 'X-Credits-Remaining': '150', 'X-RateLimit-Daily-Remaining': '50', 'Retry-After': '1' })
      const run = fetchCertPrices(one, { key: 'k' }).catch((e: Error) => e)
      await vi.advanceTimersByTimeAsync(20_000)
      expect((await run as Error).message).toMatch(/rate limited/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not claim the day is spent when the server said nothing about it', async () => {
    vi.useFakeTimers()
    try {
      stub({ 'Retry-After': '1' })
      const run = fetchCertPrices(one, { key: 'k' }).catch((e: Error) => e)
      await vi.advanceTimersByTimeAsync(20_000)
      expect((await run as Error).message).not.toMatch(/allowance/i)
    } finally {
      vi.useRealTimers()
    }
  })
})

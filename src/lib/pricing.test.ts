import { afterEach, describe, expect, it, vi } from 'vitest'
import { PriceNetworkError, pokemonTcgIo, refreshQuotes } from './pricing'

const CARD = {
  name: 'Charizard',
  number: '4',
  set: { name: 'Base Set' },
  tcgplayer: { url: 'x', updatedAt: '2026/09/01', prices: { holofoil: { low: 200, mid: 300, high: 500, market: 320, directLow: 290 } } },
}

/** Stub fetch, recording each query string the provider asks for. */
function stubFetch(handler: (query: string) => { ok?: boolean; status?: number; cards?: unknown[] } | Error) {
  const queries: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const query = new URL(String(input)).searchParams.get('q') ?? ''
    queries.push(query)
    const result = handler(query)
    if (result instanceof Error) throw result
    return {
      ok: result.ok ?? true,
      status: result.status ?? 200,
      json: async () => ({ data: result.cards ?? [] }),
    } as Response
  })
  return queries
}

afterEach(() => vi.unstubAllGlobals())

describe('lookup', () => {
  it('asks for the most specific match first', async () => {
    const queries = stubFetch(() => ({ cards: [CARD] }))
    await pokemonTcgIo.lookup({ name: 'Charizard', set: 'Base Set', number: '4' })
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('name:"Charizard"')
    expect(queries[0]).toContain('set.name:"Base Set"')
    expect(queries[0]).toContain('number:"4"')
  })

  it('widens the search when the exact combination matches nothing', async () => {
    // A slightly wrong set name must not sink the lookup: collection exports
    // get set names wrong constantly.
    const queries = stubFetch((q) => (q.includes('set.name') ? { cards: [] } : { cards: [CARD] }))
    const quote = await pokemonTcgIo.lookup({ name: 'Charizard', set: 'Base', number: '4' })
    expect(quote?.market).toBe(320)
    expect(queries.length).toBeGreaterThan(1)
    expect(queries.at(-1)).not.toContain('set.name')
  })

  it('falls back all the way to the bare name', async () => {
    const queries = stubFetch((q) => (q === 'name:"Charizard"' ? { cards: [CARD] } : { cards: [] }))
    expect(await pokemonTcgIo.lookup({ name: 'Charizard', set: 'Wrong', number: '999' })).not.toBeNull()
    expect(queries.at(-1)).toBe('name:"Charizard"')
  })

  it('stops once something matches', async () => {
    const queries = stubFetch(() => ({ cards: [CARD] }))
    await pokemonTcgIo.lookup({ name: 'Charizard', set: 'Base Set' })
    expect(queries).toHaveLength(1)
  })

  it('returns null when nothing matches at any width', async () => {
    stubFetch(() => ({ cards: [] }))
    expect(await pokemonTcgIo.lookup({ name: 'Nonexistent Card' })).toBeNull()
  })

  it('leading zeros in a card number do not prevent a match', async () => {
    const queries = stubFetch(() => ({ cards: [CARD] }))
    await pokemonTcgIo.lookup({ name: 'Pikachu', number: '044' })
    expect(queries[0]).toContain('number:"44"')
  })

  it('reads prices and normalizes the provider date format', async () => {
    stubFetch(() => ({ cards: [CARD] }))
    const quote = await pokemonTcgIo.lookup({ name: 'Charizard' })
    expect(quote).toMatchObject({ market: 320, low: 200, high: 500, directLow: 290, currency: 'USD' })
    expect(Date.parse(quote!.updatedAt!)).not.toBeNaN()
  })

  it('prefers a card that actually carries prices', async () => {
    stubFetch(() => ({ cards: [{ name: 'Charizard', tcgplayer: { prices: {} } }, CARD] }))
    expect((await pokemonTcgIo.lookup({ name: 'Charizard' }))?.market).toBe(320)
  })

  it('reports an unreachable API distinctly from a miss', async () => {
    stubFetch(() => new TypeError('Failed to fetch'))
    await expect(pokemonTcgIo.lookup({ name: 'Charizard' })).rejects.toBeInstanceOf(PriceNetworkError)
  })

  it('names rate limiting for what it is', async () => {
    stubFetch(() => ({ ok: false, status: 429 }))
    await expect(pokemonTcgIo.lookup({ name: 'Charizard' })).rejects.toThrow(/rate limited/i)
  })
})

describe('test connection', () => {
  it('confirms a working connection', async () => {
    stubFetch(() => ({ cards: [CARD] }))
    expect((await pokemonTcgIo.test()).status).toBe('ok')
  })

  it('identifies a blocked page', async () => {
    stubFetch(() => new TypeError('Failed to fetch'))
    const r = await pokemonTcgIo.test()
    expect(r.status).toBe('blocked')
    expect(r.message).toMatch(/stopped from making the request/i)
  })

  it('distinguishes rate limiting and server errors', async () => {
    stubFetch(() => ({ ok: false, status: 429 }))
    expect((await pokemonTcgIo.test()).status).toBe('rate_limited')
    vi.unstubAllGlobals()
    stubFetch(() => ({ ok: false, status: 503 }))
    expect((await pokemonTcgIo.test()).status).toBe('http_error')
  })
})

describe('refreshQuotes', () => {
  const targets = Array.from({ length: 20 }, (_, i) => ({
    key: `k${i}`,
    query: { name: `Card ${i}` },
  }))

  it('gives up immediately when the page cannot reach the API', async () => {
    // Otherwise a blocked page grinds through the whole collection to collect
    // the identical failure once per row.
    const queries = stubFetch(() => new TypeError('Failed to fetch'))
    const outcome = await refreshQuotes(targets, pokemonTcgIo)
    expect(outcome.blocked).toMatch(/could not reach/i)
    expect(outcome.quotes.size).toBe(0)
    expect(queries.length).toBeLessThan(targets.length)
  })

  it('collects per-item misses without stopping', async () => {
    stubFetch((q) => (q.includes('Card 1"') ? { cards: [] } : { cards: [CARD] }))
    const outcome = await refreshQuotes(targets.slice(0, 5), pokemonTcgIo)
    expect(outcome.blocked).toBeNull()
    expect(outcome.quotes.size).toBe(4)
    expect(outcome.errors).toHaveLength(1)
    expect(outcome.errors[0].message).toMatch(/no match/i)
  })

  it('skips what the provider cannot price, without calling out', async () => {
    const queries = stubFetch(() => ({ cards: [CARD] }))
    const outcome = await refreshQuotes(
      [{ key: 'a', query: { name: 'Booster Box' }, skipReason: 'Sealed product' }],
      pokemonTcgIo,
    )
    expect(outcome.skipped).toHaveLength(1)
    expect(queries).toHaveLength(0)
  })
})

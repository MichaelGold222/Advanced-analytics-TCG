import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// IndexedDB does not exist in the test environment; persistence is not what
// these tests are about.
vi.mock('idb-keyval', () => ({
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => undefined),
  del: vi.fn(async () => undefined),
}))

import { purgeGradedSnapshots, selectSeries, useStore } from './store'
import { pricingTuning, resetPacing } from './pricing'
import { holdingKey } from './portfolio'
import { computeFmv } from './analytics'
import type { Holding } from './types'

function holding(partial: Partial<Holding> & { name: string }): Holding {
  return {
    id: partial.name, quantity: 1, costBasis: 0, segment: 'modern',
    segmentReason: 'test', segmentOverride: null, ...partial,
  }
}

const QUOTED_PRICE = 320

function stubFetch() {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const name = new URL(String(input)).searchParams.get('q')?.match(/name:"([^"]+)"/)?.[1] ?? 'card'
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [{
          name,
          set: { name: 'Base Set' },
          tcgplayer: { updatedAt: '2026/09/17', prices: { holofoil: { low: 200, mid: 300, high: 500, market: QUOTED_PRICE } } },
        }],
      }),
    } as Response
  })
}

const RAW = holding({ name: 'Charizard ex', set: 'Obsidian Flames', condition: 'NM' })
const SLAB = holding({ name: 'Charizard', set: 'Base Set', number: '4', condition: 'PSA 9', grader: 'PSA', grade: 9 })

beforeEach(() => {
  stubFetch()
  // Exercise the real retry logic without waiting out its real backoff.
  pricingTuning.minRequestGapMs = 0
  pricingTuning.retryDelaysMs = [0, 0, 0, 0]
  resetPacing()
  useStore.setState({
    holdings: [], watchlist: [], quotes: {}, snapshots: {}, uploadedHistory: {}, error: null, feed: null,
    refresh: { running: false, done: 0, total: 0, lastRun: null, errors: [], skipped: [] },
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('the published sold-comp feed', () => {
  const SLAB_WITH_CERT = holding({
    name: 'Charizard', set: 'Base Set', number: '4', condition: 'PSA 9',
    grader: 'PSA', grade: 9, cert: '93083876',
  })

  const FEED = {
    fetchedAt: '2026-09-19T00:00:00.000Z',
    source: 'Card Ladder via Parse',
    byCert: {
      '93083876': {
        grader: 'PSA',
        clValue: 21911.69,
        lastSalePrice: 21000,
        sales: [
          { date: '2026-03-16', price: 6300, source: 'sale' as const },
          { date: '2026-06-15', price: 16200, source: 'sale' as const },
          { date: '2026-07-20', price: 11200, source: 'sale' as const },
          { date: '2026-08-24', price: 21600, source: 'sale' as const },
          { date: '2026-09-07', price: 21000, source: 'sale' as const },
        ],
      },
    },
    errors: [],
  }

  it('values a graded slab from its own cert\u2019s sales', () => {
    // The exclusion that blocks raw quotes must not block these: they are
    // sales of this card at this grade.
    useStore.setState({ holdings: [SLAB_WITH_CERT], feed: FEED })
    const series = selectSeries(useStore.getState())
    const fmv = computeFmv(series.get(holdingKey(SLAB_WITH_CERT))!, new Date('2026-09-19T00:00:00Z'))
    expect(fmv.fmv).toBe(16200)
    expect(fmv.sampleSize).toBe(5)
  })

  it('ignores the feed for a card whose cert is not in it', () => {
    const other = holding({ name: 'Blastoise', grader: 'PSA', grade: 8, cert: '00000000' })
    useStore.setState({ holdings: [other], feed: FEED })
    expect(selectSeries(useStore.getState()).get(holdingKey(other))!.points).toHaveLength(0)
  })

  it('ignores the feed for a card with no cert at all', () => {
    const noCert = holding({ name: 'Blastoise', grader: 'PSA', grade: 8 })
    useStore.setState({ holdings: [noCert], feed: FEED })
    expect(selectSeries(useStore.getState()).get(holdingKey(noCert))!.points).toHaveLength(0)
  })

  it('merges feed sales with comps the user imported', () => {
    const key = holdingKey(SLAB_WITH_CERT)
    useStore.setState({
      holdings: [SLAB_WITH_CERT],
      feed: FEED,
      uploadedHistory: { [key]: [{ date: '2026-09-15', price: 18000, source: 'sale' }] },
    })
    expect(selectSeries(useStore.getState()).get(key)!.points).toHaveLength(6)
  })

  it('works with no feed published', () => {
    useStore.setState({ holdings: [SLAB_WITH_CERT], feed: null })
    expect(selectSeries(useStore.getState()).get(holdingKey(SLAB_WITH_CERT))!.points).toHaveLength(0)
  })
})

describe('purgeGradedSnapshots', () => {
  it('drops snapshots an earlier version recorded against graded items', () => {
    const cleaned = purgeGradedSnapshots({
      'charizard|base set|4|psa9': [{ date: '2026-09-01', price: 320, source: 'snapshot' }],
      'charizard ex|obsidian flames|223|raw': [{ date: '2026-09-01', price: 50, source: 'snapshot' }],
    })
    expect(cleaned['charizard|base set|4|psa9']).toBeUndefined()
    expect(cleaned['charizard ex|obsidian flames|223|raw']).toHaveLength(1)
  })

  it('keeps the user\u2019s own imported comps on a graded item', () => {
    // Those are grade-specific and correct; only our captured raw quotes were wrong.
    const cleaned = purgeGradedSnapshots({
      'charizard|base set|4|psa10': [
        { date: '2026-09-01', price: 22000, source: 'sale' },
        { date: '2026-09-02', price: 320, source: 'snapshot' },
      ],
    })
    expect(cleaned['charizard|base set|4|psa10']).toEqual([
      { date: '2026-09-01', price: 22000, source: 'sale' },
    ])
  })

  it('handles missing state', () => {
    expect(purgeGradedSnapshots(undefined)).toEqual({})
  })
})

describe('refreshPrices', () => {
  it('records a snapshot for an ungraded card', async () => {
    useStore.setState({ holdings: [RAW] })
    await useStore.getState().refreshPrices()
    expect(useStore.getState().snapshots[holdingKey(RAW)]?.[0].price).toBe(QUOTED_PRICE)
  })

  it('never writes a raw quote into a graded card’s history', async () => {
    // The quote prices an ungraded copy. Stored history is trusted from then
    // on, so recording it would value a PSA 9 at raw money from behind the
    // exclusion that exists to prevent exactly that.
    useStore.setState({ holdings: [SLAB] })
    await useStore.getState().refreshPrices()
    expect(useStore.getState().snapshots[holdingKey(SLAB)]).toBeUndefined()
  })

  it('does not look up a graded card at all', async () => {
    // The answer is excluded from the valuation either way, so the lookup is a
    // slow request spent on something already discarded. For a collection of
    // slabs that was the entire refresh.
    useStore.setState({ holdings: [SLAB] })
    await useStore.getState().refreshPrices()
    expect(useStore.getState().quotes[holdingKey(SLAB)]).toBeUndefined()
    expect(useStore.getState().refresh.skipped).toHaveLength(1)
    expect(useStore.getState().refresh.skipped[0].reason).toMatch(/certificate number/i)
  })

  it('spends its requests on the raw cards a singles API can actually price', async () => {
    useStore.setState({ holdings: [SLAB, RAW] })
    await useStore.getState().refreshPrices()
    // One of the two was looked up; the slab was skipped before any request.
    expect(Object.keys(useStore.getState().quotes)).toEqual([holdingKey(RAW)])
    expect(useStore.getState().refresh.skipped.map((s) => s.key)).toEqual([holdingKey(SLAB)])

    const series = selectSeries(useStore.getState())
    expect(computeFmv(series.get(holdingKey(SLAB))!).fmv).toBeNull()
    expect(computeFmv(series.get(holdingKey(RAW))!).fmv).toBeGreaterThan(0)
  })

  it('does not look up sealed product', async () => {
    const box = holding({ name: 'Surging Sparks Booster Box', segment: 'sealed' })
    useStore.setState({ holdings: [box] })
    await useStore.getState().refreshPrices()
    expect(useStore.getState().refresh.skipped).toHaveLength(1)
    expect(useStore.getState().quotes[holdingKey(box)]).toBeUndefined()
  })

  it('surfaces a blocked connection as a visible error', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch') })
    useStore.setState({ holdings: [RAW] })
    await useStore.getState().refreshPrices()
    expect(useStore.getState().error).toMatch(/did not answer/i)
  })

  it('keeps one snapshot per day, updating a same-day refresh in place', async () => {
    useStore.setState({ holdings: [RAW] })
    await useStore.getState().refreshPrices()
    await useStore.getState().refreshPrices()
    expect(useStore.getState().snapshots[holdingKey(RAW)]).toHaveLength(1)
  })
})

describe('re-uploading a sheet', () => {
  const file = (name: string, csv: string) =>
    new File([csv], name, { type: 'text/csv' })
  const SHEET = 'Card Name,Set,Condition,Investment\nCharizard,Base Set,PSA 10,12000\nBlastoise,Base Set,PSA 9,1450\n'

  beforeEach(() => {
    useStore.setState({ holdings: [], watchlist: [], importLog: [] })
  })

  it('replaces the collection rather than duplicating it', async () => {
    // A collection sheet is the whole collection, so uploading a corrected
    // copy is a correction. Appending turned that into 2x every position.
    await useStore.getState().importFile(file('collection.csv', SHEET), 'portfolio')
    expect(useStore.getState().holdings).toHaveLength(2)

    await useStore.getState().importFile(file('collection.csv', SHEET), 'portfolio')
    expect(useStore.getState().holdings).toHaveLength(2)
  })

  it('picks up a corrected cost on the second upload', async () => {
    await useStore.getState().importFile(
      file('collection.csv', 'Card Name,Set,Condition\nCharizard,Base Set,PSA 10\n'), 'portfolio')
    expect(useStore.getState().holdings[0].costBasis).toBe(0)

    await useStore.getState().importFile(file('collection.csv', SHEET), 'portfolio')
    expect(useStore.getState().holdings[0].costBasis).toBe(12000)
  })

  it('combines sheets when asked to add', async () => {
    await useStore.getState().importFile(file('vintage.csv', SHEET), 'portfolio')
    await useStore.getState().importFile(
      file('modern.csv', 'Card Name,Set,Condition,Investment\nCharizard ex,Obsidian Flames,PSA 10,255\n'),
      'portfolio', 'add')
    expect(useStore.getState().holdings).toHaveLength(3)
  })

  it('leaves the watchlist alone when the portfolio is replaced', async () => {
    await useStore.getState().importFile(
      file('watch.csv', 'Card Name,Set,Condition,Asking Price\nUmbreon VMAX,Evolving Skies,PSA 10,1650\n'),
      'watchlist')
    await useStore.getState().importFile(file('collection.csv', SHEET), 'portfolio')
    expect(useStore.getState().watchlist).toHaveLength(1)
    expect(useStore.getState().holdings).toHaveLength(2)
  })
})

describe('retrying only the slabs that are missing', () => {
  const slab = (cert: string) => holding({
    name: `Card ${cert}`, condition: 'PSA 10', grader: 'PSA', grade: 10, cert,
  })

  beforeEach(() => {
    // These tests run in Node; the client keeps the key in localStorage.
    const store = new Map<string, string>([['aa-tcg.parseKey', 'k']])
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
    useStore.setState({
      holdings: [slab('111'), slab('222'), slab('333')],
      watchlist: [],
      certSales: { '111': [{ date: '2026-09-18', price: 100, source: 'sale' }] },
      gradedRefresh: { running: false, done: 0, total: 0, unmatched: [], failed: [], startedAt: null },
    })
  })

  it('asks only for the certs that have nothing yet', async () => {
    const asked: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const make = (payload: unknown) =>
        ({ ok: true, status: 200, headers: { get: () => null }, json: async () => payload }) as unknown as Response
      if (String(url).includes('/dispatch/tasks/')) return make({ result_scraper_id: 's' })
      if (String(url).includes('/dispatch/tasks')) return make({ tasks: [{ id: 't', url: 'https://cardladder.com/' }] })
      const body = JSON.parse(String(init?.body ?? '{}')) as { certs: { cert_number: string }[] }
      asked.push(...body.certs.map((c) => c.cert_number))
      return make({ status: 'success', data: { results: [], errors: [], total: 0 } })
    })

    await useStore.getState().refreshGraded({ onlyMissing: true })
    expect(asked.sort()).toEqual(['222', '333'])
  })

  it('keeps the comps it already had', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const make = (payload: unknown) =>
        ({ ok: true, status: 200, headers: { get: () => null }, json: async () => payload }) as unknown as Response
      if (String(url).includes('/dispatch/tasks/')) return make({ result_scraper_id: 's' })
      if (String(url).includes('/dispatch/tasks')) return make({ tasks: [{ id: 't', url: 'https://cardladder.com/' }] })
      return make({ status: 'success', data: { results: [], errors: [], total: 0 } })
    })
    await useStore.getState().refreshGraded({ onlyMissing: true })
    expect(useStore.getState().certSales['111']).toHaveLength(1)
  })
})

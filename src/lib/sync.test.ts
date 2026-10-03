import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('idb-keyval', () => ({
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => undefined),
  del: vi.fn(async () => undefined),
}))

import { GIST_FILE, decide, getSyncToken, makeEnvelope, readEnvelope } from './sync'
import { useStore, type PersistedState } from './store'
import type { Holding } from './types'

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  }
}

function holding(name: string): Holding {
  return {
    id: name, name, quantity: 1, costBasis: 100, segment: 'modern',
    segmentReason: 'test', segmentOverride: null,
  }
}

const EMPTY_STATE: PersistedState = {
  holdings: [], watchlist: [], uploadedHistory: {}, snapshots: {}, quotes: {}, importLog: [],
  lastRefresh: null, certSales: {}, certCardIds: {}, certFacts: {}, certDeepFetched: {},
  certLastFetched: null, certImages: {},
}

/** A fake GitHub holding at most one gist, recording what was written to it. */
function fakeGitHub(initial: PersistedState | null) {
  let content: string | null = initial ? JSON.stringify(makeEnvelope(initial, '2026-10-01T00:00:00.000Z')) : null
  const writes: string[] = []
  const json = (body: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const auth = (init?.headers as Record<string, string>)?.Authorization
    if (auth !== 'Bearer good') return json({}, 401)
    if (url.pathname === '/user') return json({ login: 'owner' })
    if (url.pathname === '/gists' && method === 'GET') {
      return json(content ? [{ id: 'g1', files: { [GIST_FILE]: {} } }] : [])
    }
    if (url.pathname === '/gists/g1' && method === 'GET') {
      return content ? json({ id: 'g1', files: { [GIST_FILE]: { content } } }) : json({}, 404)
    }
    if ((url.pathname === '/gists' && method === 'POST') || (url.pathname === '/gists/g1' && method === 'PATCH')) {
      const body = JSON.parse(String(init?.body)) as { files: Record<string, { content: string }> }
      content = body.files[GIST_FILE].content
      writes.push(content)
      return json({ id: 'g1', files: {} })
    }
    return json({}, 404)
  })
  return {
    writes,
    saved: () => (content ? readEnvelope<PersistedState>(content) : null),
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  useStore.getState().disconnectSync()
  useStore.setState({ ...EMPTY_STATE })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('decide', () => {
  const T0 = '2026-10-01T00:00:00Z'
  const T1 = '2026-10-02T00:00:00Z'
  const T2 = '2026-10-03T00:00:00Z'

  it('pushes when the account has nothing yet', () => {
    expect(decide({ remoteSavedAt: null, syncedAt: null, dirtyAt: null })).toBe('push')
  })
  it('pulls what another browser saved when nothing here is pending', () => {
    expect(decide({ remoteSavedAt: T1, syncedAt: T0, dirtyAt: null })).toBe('pull')
  })
  it('pushes a pending edit when the account has not moved', () => {
    expect(decide({ remoteSavedAt: T0, syncedAt: T0, dirtyAt: T1 })).toBe('push')
  })
  it('does nothing when both agree', () => {
    expect(decide({ remoteSavedAt: T0, syncedAt: T0, dirtyAt: null })).toBe('none')
  })
  it('lets the later edit win when both moved', () => {
    expect(decide({ remoteSavedAt: T1, syncedAt: T0, dirtyAt: T2 })).toBe('push')
    expect(decide({ remoteSavedAt: T2, syncedAt: T0, dirtyAt: T1 })).toBe('pull')
  })
})

describe('readEnvelope', () => {
  it('round-trips a backup', () => {
    const env = makeEnvelope({ ...EMPTY_STATE, holdings: [holding('Lugia')] })
    expect(readEnvelope<PersistedState>(JSON.stringify(env)).state.holdings[0].name).toBe('Lugia')
  })
  it('refuses a file that is not a backup, and says so', () => {
    expect(() => readEnvelope('not json')).toThrow(/not a backup/)
    expect(() => readEnvelope('{"holdings":[]}')).toThrow(/not a backup/)
  })
})

describe('syncing through the store', () => {
  it('brings the saved cards into an empty browser on connect', async () => {
    fakeGitHub({ ...EMPTY_STATE, holdings: [holding('Charizard'), holding('Pikachu')] })
    await useStore.getState().connectSync('good')
    const s = useStore.getState()
    expect(s.holdings.map((h) => h.name)).toEqual(['Charizard', 'Pikachu'])
    expect(s.sync.account).toBe('owner')
    expect(s.sync.status).toBe('idle')
  })

  it('saves this browser’s cards when the account has none', async () => {
    const gh = fakeGitHub(null)
    useStore.setState({ holdings: [holding('Umbreon')] })
    await useStore.getState().connectSync('good')
    expect(gh.saved()?.state.holdings.map((h) => h.name)).toEqual(['Umbreon'])
  })

  it('asks before overwriting either side when both have different cards', async () => {
    const gh = fakeGitHub({ ...EMPTY_STATE, holdings: [holding('Saved')] })
    useStore.setState({ holdings: [holding('Local')] })
    await useStore.getState().connectSync('good')
    expect(useStore.getState().sync.choice).toMatchObject({ remoteHoldings: 1 })
    expect(gh.writes).toHaveLength(0)
    expect(useStore.getState().holdings[0].name).toBe('Local')

    await useStore.getState().resolveSyncChoice('account')
    expect(useStore.getState().holdings[0].name).toBe('Saved')
    expect(useStore.getState().sync.choice).toBeNull()
  })

  it('pushes an edit made after connecting', async () => {
    const gh = fakeGitHub(null)
    await useStore.getState().connectSync('good')
    vi.useFakeTimers()
    useStore.getState().addWatchItem({ name: 'Mew', set: 'Promo' } as never)
    await vi.advanceTimersByTimeAsync(5000)
    vi.useRealTimers()
    await vi.waitFor(() => expect(gh.saved()?.state.watchlist.map((w) => w.name)).toEqual(['Mew']))
  })

  it('forgets a token GitHub rejects, and says why', async () => {
    fakeGitHub(null)
    await useStore.getState().connectSync('bad')
    expect(getSyncToken()).toBe('')
    expect(useStore.getState().sync.message).toMatch(/did not accept/)
  })

  it('leaves the account copy alone when this browser is reset', async () => {
    const gh = fakeGitHub({ ...EMPTY_STATE, holdings: [holding('Kept')] })
    await useStore.getState().connectSync('good')
    await useStore.getState().clearAll()
    expect(getSyncToken()).toBe('')
    expect(gh.saved()?.state.holdings[0].name).toBe('Kept')
  })

  it('restores a backup file into this browser', async () => {
    const text = JSON.stringify(makeEnvelope({ ...EMPTY_STATE, holdings: [holding('Backed up')] }))
    const counts = await useStore.getState().restoreBackup(text)
    expect(counts).toEqual({ holdings: 1, watchlist: 0 })
    expect(useStore.getState().holdings[0].name).toBe('Backed up')
  })
})

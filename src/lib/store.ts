/**
 * Application state.
 *
 * Everything lives in the browser: the portfolio is persisted to IndexedDB and
 * never uploaded. Each price refresh also appends a dated snapshot, so the
 * longer the app is used the more real 52-week history it owns.
 */
import { create } from 'zustand'
import { del, get, set } from 'idb-keyval'
import { buildSeries } from './analytics'
import { importWorkbook, mergeHistory, reclassify } from './ingest'
import { itemKey } from './key'
import { holdingAsWatchItem } from './portfolio'
import { refreshQuotes, type PriceProvider, type RefreshTarget } from './pricing'
import { isSupportedGrader, type PriceFeed } from './providers/cardladder'
import {
  fetchCertImages, fetchCertPrices, getParseKey, ParseError, type UsageInfo,
} from './providers/cardladder-client'
import { pokemonTcgIo } from './pricing'
import { toISODate } from './stats'
import type { Holding, PricePoint, PriceQuote, PriceSeries, Segment, WatchItem } from './types'

const DB_KEY = 'advanced-analytics-tcg/v1'
/** Keep two years of our own snapshots; the analytics window is one. */
const SNAPSHOT_RETENTION_DAYS = 730

export interface ImportLogEntry {
  at: string
  file: string
  kind: 'portfolio' | 'watchlist'
  imported: number
  sheets: string[]
  mapped: Record<string, string>
  unmappedHeaders: string[]
  /** Recognised and set aside on purpose, as opposed to not understood. */
  ignoredHeaders: string[]
  issues: { row: number; message: string }[]
  historyPoints: number
}

export interface RefreshState {
  running: boolean
  done: number
  total: number
  lastRun: string | null
  errors: { key: string; name: string; message: string }[]
  skipped: { key: string; name: string; reason: string }[]
}

interface PersistedState {
  holdings: Holding[]
  watchlist: WatchItem[]
  uploadedHistory: Record<string, PricePoint[]>
  snapshots: Record<string, PricePoint[]>
  quotes: Record<string, PriceQuote>
  importLog: ImportLogEntry[]
  lastRefresh: string | null
  /** Sold comps by certificate number, from Card Ladder. */
  certSales: Record<string, PricePoint[]>
  certLastFetched: string | null
  /** Pictures by cert. Fetched once and kept: a photo does not go stale. */
  certImages: Record<string, { image: string | null; thumbnail: string | null }>
}

/** Whether an upload replaces what is there or adds to it. */
export type ImportMode = 'replace' | 'add'

interface AppState extends PersistedState {
  hydrated: boolean
  refresh: RefreshState
  error: string | null
  /** Sold comps published alongside the site by the scheduled fetch. */
  feed: PriceFeed | null
  /** Credit counters Parse returned on the last graded fetch. */
  usage: UsageInfo | null
  gradedRefresh: { running: boolean; done: number; total: number; unmatched: string[]; failed: string[]; startedAt: number | null }

  hydrate(): Promise<void>
  loadFeed(): Promise<void>
  importFile(file: File, kind: 'portfolio' | 'watchlist', mode?: ImportMode): Promise<void>
  addWatchItem(item: Omit<WatchItem, 'id' | 'segment' | 'segmentReason'>): void
  removeWatchItem(id: string): void
  updateWatchItem(id: string, patch: Partial<WatchItem>): void
  setSegmentOverride(id: string, segment: Segment | null, kind: 'holding' | 'watch'): void
  /** A value typed in by hand, which outranks anything fetched. Null clears it. */
  setHoldingValue(id: string, value: number | null): void
  removeHolding(id: string): void
  /** Move holdings to the watchlist, keeping any prices already fetched. */
  moveToWatchlist(ids: string[]): void
  refreshPrices(provider?: PriceProvider): Promise<void>
  refreshGraded(opts?: { onlyMissing?: boolean }): Promise<void>
  /** Fetch pictures for any of these certs that has none yet. */
  refreshImages(certs: { cert_number: string; grading_company: 'PSA' | 'BGS' | 'CGC' | 'SGC' }[]): Promise<void>
  clearAll(): Promise<void>
  reportError(message: string): void
  dismissError(): void
}

const EMPTY: PersistedState = {
  holdings: [],
  watchlist: [],
  uploadedHistory: {},
  snapshots: {},
  quotes: {},
  importLog: [],
  lastRefresh: null,
  certSales: {},
  certLastFetched: null,
  certImages: {},
}

function persistable(s: AppState): PersistedState {
  return {
    holdings: s.holdings,
    watchlist: s.watchlist,
    uploadedHistory: s.uploadedHistory,
    snapshots: s.snapshots,
    quotes: s.quotes,
    importLog: s.importLog.slice(-20),
    lastRefresh: s.lastRefresh,
    certSales: s.certSales,
    certLastFetched: s.certLastFetched,
    certImages: s.certImages,
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
function scheduleSave(state: AppState) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void set(DB_KEY, persistable(state)).catch(() => {
      /* quota or private mode: the session still works, it just will not persist */
    })
  }, 300)
}

export const useStore = create<AppState>((setState, getState) => ({
  ...EMPTY,
  hydrated: false,
  refresh: { running: false, done: 0, total: 0, lastRun: null, errors: [], skipped: [] },
  error: null,
  feed: null,
  usage: null,
  gradedRefresh: { running: false, done: 0, total: 0, unmatched: [], failed: [], startedAt: null },

  /**
   * Price graded slabs from Card Ladder, by certificate number.
   *
   * Runs in the browser: Parse serves CORS, and the key is the user's own,
   * held on their device. One call covers 200 slabs.
   */
  async refreshImages(certs) {
    const key = getParseKey()
    if (!key || certs.length === 0) return
    const known = getState().certImages
    const missing = certs.filter((c) => !known[c.cert_number])
    if (missing.length === 0) return

    try {
      const { images } = await fetchCertImages(missing, { key })
      if (images.length === 0) return
      const certImages = { ...getState().certImages }
      for (const img of images) certImages[img.cert] = { image: img.image, thumbnail: img.thumbnail }
      setState({ certImages })
      scheduleSave(getState())
    } catch {
      /* a missing picture is cosmetic and must not disturb anything else */
    }
  },

  async refreshGraded(opts = {}) {
    const state = getState()
    if (state.gradedRefresh.running) return

    const key = getParseKey()
    if (!key) {
      setState({ error: 'Add your Card Ladder API key in Data & settings to price graded cards.' })
      return
    }

    const certs = new Map<string, { cert_number: string; grading_company: 'PSA' | 'BGS' | 'CGC' | 'SGC' }>()
    for (const item of [...state.holdings, ...state.watchlist]) {
      const grader = item.grader?.toUpperCase()
      if (!item.cert || !isSupportedGrader(grader)) continue
      certs.set(item.cert, { cert_number: item.cert, grading_company: grader })
    }
    // After a partial failure, going back for everything re-does work that
    // succeeded and spends the time and credits again. The slabs with nothing
    // are the ones that need another try.
    const all = [...certs.values()]
    const list = opts.onlyMissing
      ? all.filter((c) => (state.certSales[c.cert_number] ?? []).length === 0)
      : all
    if (opts.onlyMissing && list.length === 0) {
      setState({ error: 'Every slab already has sold comps. Use Fetch sold comps for newer ones.' })
      return
    }
    if (list.length === 0) {
      setState({
        error: 'No certificate numbers found. Add a Cert Number column to your sheet — graded cards are priced by cert.',
      })
      return
    }

    setState({ gradedRefresh: { running: true, done: 0, total: list.length, unmatched: [], failed: [], startedAt: Date.now() } })
    try {
      const { prices, unmatched, failed, usage, partialError } = await fetchCertPrices(list, {
        key,
        onProgress: (done, total) => setState({ gradedRefresh: { ...getState().gradedRefresh, done, total } }),
      })

      const certSales = { ...getState().certSales }
      for (const p of prices) if (p.points.length > 0) certSales[p.cert] = p.points

      const priced = prices.filter((p) => p.points.length > 0).length
      setState({
        certSales,
        certLastFetched: new Date().toISOString(),
        usage,
        // Still running: the pictures are part of this errand, and reporting
        // it finished while a call is in flight is how a fetch looks like it
        // did nothing.
        gradedRefresh: { ...getState().gradedRefresh, done: list.length, total: list.length, unmatched, failed },
        error: priced === 0
          ? `Looked up ${list.length} certificate${list.length === 1 ? '' : 's'} and none came back with sales. Check the numbers against the slab labels.`
          : partialError,
      })
      scheduleSave(getState())
    } catch (err) {
      setState({
        error: err instanceof ParseError ? err.message : `Graded price fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }

    // Pictures run whether or not the prices came back: tying them to a
    // successful price fetch meant one bad night at the upstream left a
    // collection with no photographs at all. They are fetched once per cert
    // and kept, since a photograph does not go stale the way a price does and
    // the search that carries them costs its own credit.
    try {
      await getState().refreshImages(list)
    } finally {
      setState({ gradedRefresh: { ...getState().gradedRefresh, running: false, startedAt: null } })
      scheduleSave(getState())
    }
  },

  /**
   * Load the sold-comp feed shipped with the site.
   *
   * Absent when the site was built without the pricing secrets, which is an
   * ordinary state rather than a failure: the dashboard works on whatever the
   * user imported.
   */
  async loadFeed() {
    try {
      const res = await fetch(new URL('prices.json', document.baseURI), { cache: 'no-cache' })
      if (!res.ok) return
      const feed = (await res.json()) as PriceFeed
      if (feed && typeof feed === 'object' && feed.byCert) setState({ feed })
    } catch {
      /* no feed published; nothing to report */
    }
  },

  async hydrate() {
    try {
      const saved = await get<PersistedState>(DB_KEY)
      if (saved) setState({ ...saved, snapshots: purgeGradedSnapshots(saved.snapshots), hydrated: true })
      else setState({ hydrated: true })
    } catch {
      setState({ hydrated: true })
    }
  },

  async importFile(file, kind, mode = 'replace') {
    try {
      const result = await importWorkbook(file, kind)
      const state = getState()

      // A collection sheet is the whole collection, so uploading it again is
      // a correction, not an addition. Appending turned a re-upload into a
      // duplicate of every position.
      const keepHoldings = mode === 'add' || kind !== 'portfolio'
      const keepWatchlist = mode === 'add' || kind !== 'watchlist'
      const holdings = keepHoldings ? [...state.holdings] : []
      const watchlist = keepWatchlist ? [...state.watchlist] : []
      let imported = 0
      const sheets: string[] = []
      const mapped: Record<string, string> = {}
      const unmappedHeaders: string[] = []
      const ignoredHeaders: string[] = []
      const issues: ImportLogEntry['issues'] = []

      for (const r of result.holdings) {
        holdings.push(...r.items)
        imported += r.items.length
        sheets.push(r.sheetName)
        Object.assign(mapped, r.mapped)
        unmappedHeaders.push(...r.unmappedHeaders)
        ignoredHeaders.push(...r.ignoredHeaders)
        issues.push(...r.issues)
      }
      for (const r of result.watchlist) {
        watchlist.push(...r.items)
        imported += r.items.length
        sheets.push(r.sheetName)
        Object.assign(mapped, r.mapped)
        unmappedHeaders.push(...r.unmappedHeaders)
        ignoredHeaders.push(...r.ignoredHeaders)
        issues.push(...r.issues)
      }

      const uploadedHistory = { ...state.uploadedHistory }
      mergeHistory(uploadedHistory, result.priceHistory)
      const historyPoints = Object.values(result.priceHistory).reduce((a, p) => a + p.length, 0)

      if (imported === 0) {
        setState({
          error: `No rows could be read from ${file.name}. The sheet needs a header row with at least a card or item name column — the template download shows the expected shape.`,
        })
        return
      }

      const entry: ImportLogEntry = {
        at: new Date().toISOString(), file: file.name, kind, imported,
        sheets: [...new Set(sheets)], mapped,
        unmappedHeaders: [...new Set(unmappedHeaders)],
        ignoredHeaders: [...new Set(ignoredHeaders)],
        issues: issues.slice(0, 50), historyPoints,
      }

      const next = {
        holdings, watchlist, uploadedHistory,
        importLog: [...state.importLog, entry],
        error: null,
      }
      setState(next)
      scheduleSave(getState())
    } catch (err) {
      setState({
        error: `Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  },

  addWatchItem(item) {
    const cls = reclassify({ ...item, segmentOverride: item.segmentOverride ?? null })
    const key = itemKey(item)
    const watchItem: WatchItem = { ...item, id: `${key}#m${Date.now()}`, ...cls }
    setState({ watchlist: [...getState().watchlist, watchItem] })
    scheduleSave(getState())
  },

  removeWatchItem(id) {
    setState({ watchlist: getState().watchlist.filter((w) => w.id !== id) })
    scheduleSave(getState())
  },

  updateWatchItem(id, patch) {
    setState({
      watchlist: getState().watchlist.map((w) => {
        if (w.id !== id) return w
        const merged = { ...w, ...patch }
        return { ...merged, ...reclassify(merged) }
      }),
    })
    scheduleSave(getState())
  },

  setHoldingValue(id, value) {
    setState({
      holdings: getState().holdings.map((h) =>
        h.id === id ? { ...h, userPrice: value == null || !(value > 0) ? undefined : value } : h,
      ),
    })
    scheduleSave(getState())
  },

  setSegmentOverride(id, segment, kind) {
    if (kind === 'holding') {
      setState({
        holdings: getState().holdings.map((h) => {
          if (h.id !== id) return h
          const merged = { ...h, segmentOverride: segment }
          return { ...merged, ...reclassify(merged) }
        }),
      })
    } else {
      setState({
        watchlist: getState().watchlist.map((w) => {
          if (w.id !== id) return w
          const merged = { ...w, segmentOverride: segment }
          return { ...merged, ...reclassify(merged) }
        }),
      })
    }
    scheduleSave(getState())
  },

  removeHolding(id) {
    setState({ holdings: getState().holdings.filter((h) => h.id !== id) })
    scheduleSave(getState())
  },

  /**
   * Move holdings to the watchlist, where they should have been all along.
   *
   * Added because a routing bug put a watchlist into holdings, and telling
   * someone to upload both sheets again is a poor answer when the rows are
   * sitting right there and nothing about them needs re-reading. It is not a
   * one-off repair: putting a row in the wrong tab is an ordinary mistake and
   * this is the ordinary way back.
   *
   * Prices are keyed by card rather than by tab, so anything already fetched
   * for these cards still applies to them on the other side.
   */
  moveToWatchlist(ids) {
    const state = getState()
    const moving = new Set(ids)
    const picked = state.holdings.filter((h) => moving.has(h.id))
    if (picked.length === 0) return
    const already = new Set(state.watchlist.map((w) => itemKey(w)))
    const added = picked
      .map(holdingAsWatchItem)
      .filter((w) => !already.has(itemKey(w)))
    setState({
      holdings: state.holdings.filter((h) => !moving.has(h.id)),
      watchlist: [...state.watchlist, ...added],
    })
    scheduleSave(getState())
  },

  async refreshPrices(provider = pokemonTcgIo) {
    const state = getState()
    if (state.refresh.running) return

    const targets = new Map<string, RefreshTarget>()
    const add = (item: Holding | WatchItem) => {
      const key = itemKey(item)
      if (targets.has(key)) return
      targets.set(key, {
        key,
        query: { name: item.name, set: item.set, number: item.number, cert: item.cert },
        graded: item.grade != null,
        // A raw-card quote is excluded from a slab's valuation, and its
        // snapshot is dropped below — so looking one up spends a slow,
        // frequently-failing request to produce something already discarded.
        // For a collection of slabs that was the whole refresh.
        skipReason:
          item.grade != null
            ? 'Graded slab — priced from its own sold comps by certificate number, not a raw-card quote.'
            : item.segment === 'sealed' && !provider.coversSealed
              ? 'Sealed product — this provider prices singles only. Import your own sold comps to value it.'
              : undefined,
      })
    }
    state.holdings.forEach(add)
    state.watchlist.forEach(add)

    const list = [...targets.values()]
    if (list.length === 0) return

    setState({ refresh: { ...state.refresh, running: true, done: 0, total: list.length, errors: [], skipped: [] } })

    try {
      const outcome = await refreshQuotes(list, provider, {
        onProgress: (done, total) => setState({ refresh: { ...getState().refresh, done, total } }),
      })

      const today = toISODate(new Date())
      const gradedKeys = new Set(list.filter((t) => t.graded).map((t) => t.key))
      const snapshots = { ...getState().snapshots }
      const quotes = { ...getState().quotes }
      const cutoff = toISODate(new Date(Date.now() - SNAPSHOT_RETENTION_DAYS * 86_400_000))

      for (const [key, quote] of outcome.quotes) {
        quotes[key] = quote
        const price = quote.market ?? quote.mid
        if (price == null || price <= 0) continue
        // A snapshot becomes permanent history, and this quote prices a raw
        // card. Recording it against a slab would value a PSA 10 at ungraded
        // money — and would do it behind the exclusion that exists to stop
        // exactly that, since stored history is trusted from then on.
        if (gradedKeys.has(key)) continue
        const existing = (snapshots[key] ?? []).filter((p) => p.date >= cutoff)
        // One snapshot per key per day; a same-day refresh updates in place.
        const withoutToday = existing.filter((p) => p.date !== today)
        withoutToday.push({ date: today, price, source: 'snapshot' })
        snapshots[key] = withoutToday.sort((a, b) => a.date.localeCompare(b.date))
      }

      const priced = outcome.quotes.size
      setState({
        quotes, snapshots, lastRefresh: new Date().toISOString(),
        refresh: {
          running: false, done: outcome.attempted, total: outcome.attempted,
          lastRun: new Date().toISOString(), errors: outcome.errors, skipped: outcome.skipped,
        },
        // A refresh that priced nothing must say so where it will be seen.
        error: outcome.blocked
          ? outcome.blocked
          : priced === 0 && outcome.attempted > 0
            ? `Priced none of the ${outcome.attempted} items looked up. The price service is currently failing about half of all requests, so running the refresh again often picks up what it missed. If it never succeeds, use Test connection in Data & settings.`
            : priced < outcome.attempted
              ? `Priced ${priced} of ${outcome.attempted}. The price service is currently unreliable — run the refresh again to fill in the rest.`
              : null,
      })
      scheduleSave(getState())
    } catch (err) {
      setState({
        refresh: { ...getState().refresh, running: false },
        error: `Price refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  },

  async clearAll() {
    setState({ ...EMPTY, hydrated: true, error: null, refresh: { running: false, done: 0, total: 0, lastRun: null, errors: [], skipped: [] } })
    await del(DB_KEY).catch(() => {})
  },

  reportError(message) {
    setState({ error: message })
  },

  dismissError() {
    setState({ error: null })
  },
}))

/**
 * Drop captured snapshots belonging to graded items.
 *
 * An earlier version recorded a raw-card quote as history against a slab,
 * which then fed its valuation as trusted data. The grade is the last segment
 * of the key, so the bad rows identify themselves. Imported comps are kept:
 * those are the user's own, and are grade-specific.
 */
export function purgeGradedSnapshots(
  snapshots: Record<string, PricePoint[]> = {},
): Record<string, PricePoint[]> {
  const out: Record<string, PricePoint[]> = {}
  for (const [key, points] of Object.entries(snapshots)) {
    const isGraded = key.split('|').pop() !== 'raw'
    const kept = isGraded ? points.filter((p) => p.source !== 'snapshot') : points
    if (kept.length > 0) out[key] = kept
  }
  return out
}

/** Build the price series for every known item, keyed for lookup. */
export function selectSeries(state: AppState): Map<string, PriceSeries> {
  const out = new Map<string, PriceSeries>()
  const build = (item: Holding | WatchItem) => {
    const key = itemKey(item)
    if (out.has(key)) return
    // Feed sales are grade-specific by construction — they are sales of this
    // certificate's card at this grade — so they count as the item's own
    // history, unlike a raw-card quote.
    const fromCerts = item.cert
      ? [...(state.certSales[item.cert] ?? []), ...(state.feed?.byCert[item.cert]?.sales ?? [])]
      : []
    const uploaded = [...(state.uploadedHistory[key] ?? []), ...fromCerts]
    out.set(
      key,
      buildSeries(key, uploaded, state.snapshots[key], state.quotes[key], {
        graded: item.grade != null,
      }),
    )
  }
  state.holdings.forEach(build)
  state.watchlist.forEach(build)
  return out
}

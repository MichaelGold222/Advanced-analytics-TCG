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
import { refreshQuotes, type PriceProvider, type RefreshTarget } from './pricing'
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
}

interface AppState extends PersistedState {
  hydrated: boolean
  refresh: RefreshState
  error: string | null

  hydrate(): Promise<void>
  importFile(file: File, kind: 'portfolio' | 'watchlist'): Promise<void>
  addWatchItem(item: Omit<WatchItem, 'id' | 'segment' | 'segmentReason'>): void
  removeWatchItem(id: string): void
  updateWatchItem(id: string, patch: Partial<WatchItem>): void
  setSegmentOverride(id: string, segment: Segment | null, kind: 'holding' | 'watch'): void
  removeHolding(id: string): void
  refreshPrices(provider?: PriceProvider): Promise<void>
  clearAll(): Promise<void>
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

  async hydrate() {
    try {
      const saved = await get<PersistedState>(DB_KEY)
      if (saved) setState({ ...saved, hydrated: true })
      else setState({ hydrated: true })
    } catch {
      setState({ hydrated: true })
    }
  },

  async importFile(file, kind) {
    try {
      const result = await importWorkbook(file, kind)
      const state = getState()

      const holdings = [...state.holdings]
      const watchlist = [...state.watchlist]
      let imported = 0
      const sheets: string[] = []
      const mapped: Record<string, string> = {}
      const unmappedHeaders: string[] = []
      const issues: ImportLogEntry['issues'] = []

      for (const r of result.holdings) {
        holdings.push(...r.items)
        imported += r.items.length
        sheets.push(r.sheetName)
        Object.assign(mapped, r.mapped)
        unmappedHeaders.push(...r.unmappedHeaders)
        issues.push(...r.issues)
      }
      for (const r of result.watchlist) {
        watchlist.push(...r.items)
        imported += r.items.length
        sheets.push(r.sheetName)
        Object.assign(mapped, r.mapped)
        unmappedHeaders.push(...r.unmappedHeaders)
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
        sheets: [...new Set(sheets)], mapped, unmappedHeaders: [...new Set(unmappedHeaders)],
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

  async refreshPrices(provider = pokemonTcgIo) {
    const state = getState()
    if (state.refresh.running) return

    const targets = new Map<string, RefreshTarget>()
    const add = (item: Holding | WatchItem) => {
      const key = itemKey(item)
      if (targets.has(key)) return
      targets.set(key, {
        key,
        query: { name: item.name, set: item.set, number: item.number },
        skipReason:
          item.segment === 'sealed' && !provider.coversSealed
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
      const snapshots = { ...getState().snapshots }
      const quotes = { ...getState().quotes }
      const cutoff = toISODate(new Date(Date.now() - SNAPSHOT_RETENTION_DAYS * 86_400_000))

      for (const [key, quote] of outcome.quotes) {
        quotes[key] = quote
        const price = quote.market ?? quote.mid
        if (price == null || price <= 0) continue
        const existing = (snapshots[key] ?? []).filter((p) => p.date >= cutoff)
        // One snapshot per key per day; a same-day refresh updates in place.
        const withoutToday = existing.filter((p) => p.date !== today)
        withoutToday.push({ date: today, price, source: 'snapshot' })
        snapshots[key] = withoutToday.sort((a, b) => a.date.localeCompare(b.date))
      }

      setState({
        quotes, snapshots, lastRefresh: new Date().toISOString(),
        refresh: {
          running: false, done: outcome.attempted, total: outcome.attempted,
          lastRun: new Date().toISOString(), errors: outcome.errors, skipped: outcome.skipped,
        },
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

  dismissError() {
    setState({ error: null })
  },
}))

/** Build the price series for every known item, keyed for lookup. */
export function selectSeries(state: AppState): Map<string, PriceSeries> {
  const out = new Map<string, PriceSeries>()
  const build = (item: Holding | WatchItem) => {
    const key = itemKey(item)
    if (out.has(key)) return
    out.set(
      key,
      buildSeries(key, state.uploadedHistory[key], state.snapshots[key], state.quotes[key], {
        graded: item.grade != null,
      }),
    )
  }
  state.holdings.forEach(build)
  state.watchlist.forEach(build)
  return out
}

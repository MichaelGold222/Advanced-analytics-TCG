/**
 * Application state.
 *
 * Everything lives in the browser: the portfolio is persisted to IndexedDB and
 * never uploaded. Each price refresh also appends a dated snapshot, so the
 * longer the app is used the more real 52-week history it owns.
 */
import { create } from 'zustand'
import { del, get, set } from 'idb-keyval'
import { WINDOW_COVERED_FRACTION, WINDOW_DAYS, buildSeries } from './analytics'
import { AltError, fetchAltCerts } from './providers/alt-client'
import { importWorkbook, mergeHistory, reclassify } from './ingest'
import { itemKey } from './key'
import { holdingAsWatchItem } from './portfolio'
import { refreshQuotes, type PriceProvider, type RefreshTarget } from './pricing'
import { isSupportedGrader, mergeSalePoints, type PriceFeed } from './providers/cardladder'
import {
  fetchCertImages, fetchCertPrices, getParseKey, ParseError, type UsageInfo,
  fetchCardHistory,
} from './providers/cardladder-client'
import { pokemonTcgIo } from './pricing'
import { daysAgo, toISODate } from './stats'
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
  /** Which tab each sheet's rows were sent to. */
  routed: { sheet: string; to: 'holdings' | 'watchlist' | 'price history'; because?: string }[]
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
  /** Card Ladder's own id per cert, needed by the deep-history endpoint. */
  certCardIds: Record<string, string>
  /** Value and population per cert, both free in the bulk search response. */
  certFacts: Record<string, { clValue: number | null; pop: number | null }>
  /**
   * Certs whose full history has already been fetched, and how it went.
   *
   * Deep history is a one-time cost per card: the record does not get any
   * older, so having walked it once there is nothing to gain from walking it
   * again. Kept so the button cannot quietly re-spend on a card it already
   * paid for, and so an endpoint that refused is not asked again every time.
   */
  certDeepFetched: Record<string, {
    at: string
    /** Dated price points stored. */
    sales: number
    /** Individual sales those points stand for, as the API counted them. */
    underlying?: number
    unavailable: boolean
  }>
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
  gradedRefresh: {
    running: boolean; done: number; total: number; unmatched: string[]; failed: string[]
    startedAt: number | null
    /** Which half is running: the cheap bulk pass, or the per-card history walk. */
    phase?: 'prices' | 'history'
  }

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
  /** Remove several holdings in one update, rather than one re-analysis each. */
  removeHoldings(ids: string[]): void
  removeWatchItems(ids: string[]): void
  /** Move holdings to the watchlist, keeping any prices already fetched. */
  moveToWatchlist(ids: string[]): void
  refreshPrices(provider?: PriceProvider): Promise<void>
  refreshGraded(opts?: { onlyMissing?: boolean }): Promise<void>
  /** Fetch pictures for any of these certs that has none yet. */
  refreshImages(certs: { cert_number: string; grading_company: 'PSA' | 'BGS' | 'CGC' | 'SGC' }[]): Promise<void>
  /** Walk the full sales history of any card whose record is still too short. */
  backfillHistory(): Promise<void>
  /** Fetch real sales history from Alt, by certificate, for every card. */
  fetchFromAlt(certs: string[]): Promise<void>
  /** Add price history a person pasted in, for a card the API cannot reach. */
  addPastedHistory(key: string, points: PricePoint[]): void
  /**
   * Bind a cert to a Card Ladder card id taken from that site's URL, and
   * fetch that card's history immediately. Resolves to what happened, so the
   * paste box can appear only once the cheap route has actually been refused.
   */
  linkCardId(cert: string, cardId: string): Promise<'fetched' | 'refused' | 'no-key'>
  /** Empty holdings or the watchlist, keeping prices, photos and the other list. */
  clearList(kind: 'portfolio' | 'watchlist'): void
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
  certCardIds: {},
  certFacts: {},
  certDeepFetched: {},
  certLastFetched: null,
  certImages: {},
}

/**
 * Fill in fields that did not exist when this state was written.
 *
 * What comes back from storage was saved by whatever version of this app the
 * owner last ran, which may be months old and will not have fields added
 * since. Spreading it in verbatim puts `undefined` where the code expects an
 * array, and the first component to read `.length` from one throws during
 * render — which in React unmounts the whole tree and leaves a blank page. An
 * added field turning every returning user's screen black is a severe result
 * for a change that looked additive, and the fix belongs here, once, rather
 * than in every component that reads one of these.
 */
function migrate(saved: PersistedState): PersistedState {
  return {
    ...saved,
    holdings: saved.holdings ?? [],
    watchlist: saved.watchlist ?? [],
    uploadedHistory: saved.uploadedHistory ?? {},
    snapshots: saved.snapshots ?? {},
    quotes: saved.quotes ?? {},
    certSales: saved.certSales ?? {},
    certCardIds: saved.certCardIds ?? {},
    certFacts: saved.certFacts ?? {},
    certDeepFetched: saved.certDeepFetched ?? {},
    certLastFetched: saved.certLastFetched ?? null,
    certImages: saved.certImages ?? {},
    importLog: (saved.importLog ?? []).map((e) => ({
      ...e,
      mapped: e.mapped ?? {},
      unmappedHeaders: e.unmappedHeaders ?? [],
      ignoredHeaders: e.ignoredHeaders ?? [],
      routed: e.routed ?? [],
      issues: e.issues ?? [],
      sheets: e.sheets ?? [],
    })),
  }
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
    certCardIds: s.certCardIds,
    certFacts: s.certFacts,
    certDeepFetched: s.certDeepFetched,
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
   * The cheap call, and the one that does most of the work.
   *
   * `search_by_certs_bulk` is 1 credit for up to 200 certs and carries sales,
   * `cl_value`, population, pictures and the card id — measured returning
   * more sales than the 3-credit price call, better dated. So this is the
   * main pass of a refresh, not a cosmetic afterthought, which is why it no
   * longer skips certs that already have a photograph: a picture does not go
   * stale, but a price does, and the sales are the point.
   *
   * Still named for the pictures because renaming it is churn; read it as
   * "refresh from the bulk search".
   */
  async refreshImages(certs) {
    const key = getParseKey()
    if (!key || certs.length === 0) return

    try {
      const { images, usage } = await fetchCertImages(certs, { key })
      if (usage) setState({ usage })
      if (images.length === 0) return
      const certImages = { ...getState().certImages }
      const certCardIds = { ...getState().certCardIds }
      const certFacts = { ...getState().certFacts }
      // The same response carries sales, and measured against the live API it
      // carries MORE of them than the price call does, with better dates. They
      // were being parsed for pictures and discarded. Merged, never replaced:
      // this runs after the price fetch and must not narrow what that found.
      const certSales = { ...getState().certSales }
      for (const img of images) {
        if (img.image || img.thumbnail) {
          certImages[img.cert] = { image: img.image, thumbnail: img.thumbnail }
        }
        if (img.sales.length > 0) {
          certSales[img.cert] = mergeSalePoints(certSales[img.cert] ?? [], img.sales)
        }
        // The id the deep-history endpoint needs, free in this response.
        if (img.cardId) certCardIds[img.cert] = img.cardId
        // As are the value and the population, which the price call was being
        // spent on separately.
        if (img.clValue != null || img.pop != null) {
          certFacts[img.cert] = {
            clValue: img.clValue ?? certFacts[img.cert]?.clValue ?? null,
            pop: img.pop ?? certFacts[img.cert]?.pop ?? null,
          }
        }
      }
      setState({ certImages, certSales, certCardIds, certFacts })
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

    setState({ gradedRefresh: { running: true, done: 0, total: list.length, unmatched: [], failed: [], startedAt: Date.now(), phase: 'prices' } })

    // The cheap call goes FIRST, and for most refreshes it is the only one.
    //
    // Measured, run 30: search_by_certs_bulk is charged 1 credit against the
    // price call's 3, and returned TEN sales for a cert where the price call
    // returned five — better dated, too, since the price call dated all five
    // of its own to the day of the request. It also carries cl_value,
    // current_value, market_value, the population, the pictures and the card
    // id the deep-history endpoint needs. There is nothing the price call
    // gives that this one does not, and it costs a third as much.
    //
    // Leading with the price call therefore spent 9 credits of every 12 on
    // strictly less data. It now runs only for certs the search could not
    // answer for, which is a gap-filler rather than the main path: a full
    // refresh of the collection goes from 12 credits to 3.
    let answered = new Set<string>()
    try {
      await getState().refreshImages(list)
      const sales = getState().certSales
      answered = new Set(list.map((c) => c.cert_number).filter((c) => (sales[c] ?? []).length > 0))
    } catch {
      // The search failing just means the price call has everything to do.
    }

    const gaps = list.filter((c) => !answered.has(c.cert_number))
    if (gaps.length === 0) {
      setState({
        certLastFetched: new Date().toISOString(),
        gradedRefresh: { ...getState().gradedRefresh, done: list.length, total: list.length },
      })
      scheduleSave(getState())
      try {
        await getState().backfillHistory()
      } finally {
        setState({ gradedRefresh: { ...getState().gradedRefresh, running: false, startedAt: null } })
        scheduleSave(getState())
      }
      return
    }

    setState({ gradedRefresh: { ...getState().gradedRefresh, done: 0, total: gaps.length, phase: 'prices' } })
    try {
      const { prices, unmatched, failed, usage, partialError } = await fetchCertPrices(gaps, {
        key,
        onProgress: (done, total) => setState({ gradedRefresh: { ...getState().gradedRefresh, done, total } }),
      })

      // Union, not replace. The upstream returns only the newest few sales
      // per cert, so overwriting discarded everything that had since aged out
      // of its window — the record got shallower the more often it was
      // refreshed. See mergeSalePoints.
      const certSales = { ...getState().certSales }
      for (const p of prices) {
        if (p.points.length === 0) continue
        certSales[p.cert] = mergeSalePoints(certSales[p.cert] ?? [], p.points)
      }

      const priced = prices.filter((p) => p.points.length > 0).length
      setState({
        certSales,
        certLastFetched: new Date().toISOString(),
        usage,
        // Still running: the pictures are part of this errand, and reporting
        // it finished while a call is in flight is how a fetch looks like it
        // did nothing.
        gradedRefresh: { ...getState().gradedRefresh, done: gaps.length, total: gaps.length, unmatched, failed },
        error: priced === 0 && answered.size === 0
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
    // And then the part that makes a yearly high real. The bulk endpoints hand
    // back the newest five sales per slab, which on an active card is days —
    // so any card whose record still does not reach back a year gets its full
    // history walked once, here, without being asked for separately. It is a
    // one-time cost per card by construction: the record only ever deepens, so
    // a card that has been walked is never walked again.
    try {
      await getState().backfillHistory()
    } finally {
      setState({ gradedRefresh: { ...getState().gradedRefresh, running: false, startedAt: null } })
      scheduleSave(getState())
    }
  },

  /**
   * Walk the full sales history of every card that still needs it.
   *
   * Runs off the back of a refresh rather than as its own button: the owner
   * asked for the numbers to be right when the button is pressed, not for
   * another button to press afterwards.
   *
   * Three things keep it from running away, which matters because the cost of
   * the endpoint has never been measured:
   *
   *   - only cards whose record does not reach back a year are candidates, so
   *     a well-covered collection spends nothing;
   *   - a cert that has been walked is recorded and never walked again, since
   *     history does not get older;
   *   - a refusal is recorded too, so an endpoint that is not available is
   *     asked once rather than on every refresh forever.
   */
  /**
   * History typed or pasted in by hand, for a card no call can reach.
   *
   * Card Ladder keeps promos outside the `cards` collection the Parse wrapper
   * reads, so a promo answers 422 even when handed its own Card Ladder id off
   * the site's own URL. There is no query, certificate or id that reaches it —
   * and a collection can be mostly promos. This is not a fallback for those
   * cards, it is the only route.
   *
   * Merged rather than replaced, and merged into the same uploadedHistory a
   * spreadsheet writes to, so pasting twice costs nothing and a later import
   * does not wipe it.
   */
  addPastedHistory(key, points) {
    if (points.length === 0) return
    const uploadedHistory = { ...getState().uploadedHistory }
    uploadedHistory[key] = mergeSalePoints(uploadedHistory[key] ?? [], points)
    setState({ uploadedHistory })
    scheduleSave(getState())
  },

  /**
   * A card id handed over by hand, because the certificate route reaches
   * almost nothing here.
   *
   * Measured: 31 of 32 watchlist certs come back from the bulk search with a
   * 40-character hash rather than a card id. The site itself puts the id in
   * the address bar of every card page, so one paste is all it takes — and a
   * credit then buys that card's entire history, against typing its sales in
   * by hand. Worth trying before any manual entry.
   *
   * It fetches straight away rather than waiting for the next refresh: the
   * point is to find out whether this card is reachable at all, and a person
   * who has just pasted a URL is owed that answer now. A refusal is recorded
   * like any other, so the card is not asked again on every refresh.
   */
  async linkCardId(cert, cardId) {
    const key = getParseKey()
    if (!key) {
      setState({ error: 'Add your Card Ladder API key in Data & settings first.' })
      return 'no-key'
    }
    setState({ certCardIds: { ...getState().certCardIds, [cert]: cardId } })

    try {
      const { history, usage } = await fetchCardHistory([{ cert, cardId }], { key })
      const got = history[0]
      const certSales = { ...getState().certSales }
      const certDeepFetched = { ...getState().certDeepFetched }
      const at = new Date().toISOString()
      if (got && got.sales.length > 0) {
        certSales[cert] = mergeSalePoints(certSales[cert] ?? [], got.sales)
      }
      certDeepFetched[cert] = {
        at, sales: got?.sales.length ?? 0,
        unavailable: got?.unavailable ?? true, underlying: got?.underlying ?? 0,
      }
      setState({ certSales, certDeepFetched, usage: usage ?? getState().usage })
      scheduleSave(getState())
      return got && got.sales.length > 0 ? 'fetched' : 'refused'
    } catch (err) {
      setState({
        error: err instanceof ParseError ? err.message
          : `Could not fetch that card: ${err instanceof Error ? err.message : String(err)}`,
      })
      return 'refused'
    }
  },

  /**
   * Sales history from Alt, keyed on the certificate.
   *
   * This is the route that works where the others do not. Card Ladder reaches
   * a card only through a card id, and 31 of 32 certificates here cannot
   * produce one — a promo is not in the catalogue collection it reads. Alt
   * indexes by certificate, which every row already has.
   *
   * Measured on cert 77865285, a promo Card Ladder could not touch: 1,422
   * sales spanning 2020 to 2026, a real twelve-month band of $198-$1,000 from
   * 394 of them, for 2 credits. The app's own figure at the time was
   * $462-$568 "over 57 days" — a yearly high wrong by 43%, because five sales
   * happened to land on a quiet stretch.
   *
   * Merged like everything else, so it deepens the record rather than
   * replacing it, and nothing already fetched is lost.
   */
  async fetchFromAlt(certs) {
    const key = getParseKey()
    if (!key) {
      setState({ error: 'Add your Parse API key in Data & settings first.' })
      return
    }
    const list = [...new Set(certs.filter(Boolean))]
    if (list.length === 0) return

    setState({
      gradedRefresh: {
        ...getState().gradedRefresh, running: true, done: 0, total: list.length,
        unmatched: [], failed: [], startedAt: Date.now(), phase: 'history',
      },
    })

    try {
      const { certs: got, missing, creditsCharged, creditsRemaining } = await fetchAltCerts(list, {
        key,
        onProgress: (done, total) => setState({
          gradedRefresh: { ...getState().gradedRefresh, done, total, phase: 'history' },
        }),
      })

      const certSales = { ...getState().certSales }
      const certFacts = { ...getState().certFacts }
      const certDeepFetched = { ...getState().certDeepFetched }
      const at = new Date().toISOString()
      for (const c of got) {
        if (c.sales.length > 0) certSales[c.cert] = mergeSalePoints(certSales[c.cert] ?? [], c.sales)
        if (c.altValue != null || c.population != null) {
          certFacts[c.cert] = {
            clValue: certFacts[c.cert]?.clValue ?? c.altValue ?? null,
            pop: c.population ?? certFacts[c.cert]?.pop ?? null,
          }
        }
        // Alt answering means the card is reachable, whatever Card Ladder said.
        certDeepFetched[c.cert] = {
          at, sales: c.sales.length, unavailable: false, underlying: c.salesCount ?? c.sales.length,
        }
      }

      setState({
        certSales, certFacts, certDeepFetched,
        certLastFetched: at,
        usage: creditsRemaining == null ? getState().usage : {
          ...getState().usage, creditsRemaining,
        } as AppState['usage'],
        error: missing.length > 0
          ? `Alt had nothing for ${missing.length} certificate${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}. Spent ${creditsCharged} credits.`
          : null,
      })
      scheduleSave(getState())
    } catch (err) {
      // Whatever arrived before the failure is already merged and kept.
      setState({
        error: err instanceof AltError ? err.message
          : `Alt lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    } finally {
      setState({ gradedRefresh: { ...getState().gradedRefresh, running: false, startedAt: null } })
      scheduleSave(getState())
    }
  },

  async backfillHistory() {
    const key = getParseKey()
    if (!key) return
    const state = getState()

    const now = new Date()
    const wanted: { cert: string; cardId: string }[] = []
    const seen = new Set<string>()
    /** cardId -> every cert in the collection that shares that card. */
    const byCard = new Map<string, string[]>()
    for (const item of [...state.holdings, ...state.watchlist]) {
      const cert = item.cert
      if (!cert || seen.has(cert)) continue
      seen.add(cert)
      const cardId = state.certCardIds[cert]
      // No id means the bulk search has not run for it, or the cert is not in
      // the catalogue — either way the endpoint would refuse.
      if (!cardId) continue
      if (state.certDeepFetched[cert]) continue
      const sales = (state.certSales[cert] ?? []).filter((p) => p.source === 'sale')
      if (sales.length === 0) continue
      const oldest = sales.reduce((a, b) => (a.date <= b.date ? a : b)).date
      if (daysAgo(oldest, now) >= WINDOW_DAYS * WINDOW_COVERED_FRACTION) continue
      // One call per CARD, not per slab. card_id identifies the card at a
      // grade, so every PSA 10 of it shares one history — two copies in the
      // collection, or a copy held and another watched, cost one credit
      // between them rather than two. Both certs are recorded as fetched.
      if (byCard.has(cardId)) { byCard.get(cardId)!.push(cert); continue }
      byCard.set(cardId, [cert])
      wanted.push({ cert, cardId })
    }
    if (wanted.length === 0) return

    setState({
      gradedRefresh: {
        ...getState().gradedRefresh, running: true, done: 0, total: wanted.length,
        phase: 'history',
      },
    })

    try {
      const { history, usage } = await fetchCardHistory(wanted, {
        key,
        onProgress: (done, total) => setState({
          gradedRefresh: { ...getState().gradedRefresh, done, total, phase: 'history' },
        }),
      })
      const certSales = { ...getState().certSales }
      const certDeepFetched = { ...getState().certDeepFetched }
      const at = new Date().toISOString()
      const cardOf = new Map(wanted.map((w) => [w.cert, w.cardId]))
      for (const h of history) {
        // The history belongs to the card, so it goes to every cert that
        // shares it — and each is marked fetched, so none is paid for twice.
        const shared = byCard.get(cardOf.get(h.cert) ?? '') ?? [h.cert]
        for (const cert of shared) {
          if (h.sales.length > 0) certSales[cert] = mergeSalePoints(certSales[cert] ?? [], h.sales)
          certDeepFetched[cert] = {
            at, sales: h.sales.length, unavailable: h.unavailable, underlying: h.underlying,
          }
        }
      }
      setState({ certSales, certDeepFetched, usage: usage ?? getState().usage })
      scheduleSave(getState())
    } catch (err) {
      // Out of credits or rate limited: nothing is marked done, so the next
      // refresh picks up exactly where this one stopped.
      setState({
        error: err instanceof ParseError
          ? `Full history stopped: ${err.message}`
          : `Full history stopped: ${err instanceof Error ? err.message : String(err)}`,
      })
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
      if (saved) setState({ ...migrate(saved), snapshots: purgeGradedSnapshots(saved.snapshots), hydrated: true })
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
        sheets: [...new Set(sheets)], routed: result.routed, mapped,
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
   * Remove several at once, in a single update.
   *
   * Not a loop over `removeHolding`: each call sets state, and every state
   * change re-analyses the collection. Deleting twenty rows one at a time
   * would pay that twenty times over for nineteen intermediate lists nobody
   * sees.
   */
  removeHoldings(ids) {
    if (ids.length === 0) return
    const gone = new Set(ids)
    setState({ holdings: getState().holdings.filter((h) => !gone.has(h.id)) })
    scheduleSave(getState())
  },

  removeWatchItems(ids) {
    if (ids.length === 0) return
    const gone = new Set(ids)
    setState({ watchlist: getState().watchlist.filter((w) => !gone.has(w.id)) })
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

  /**
   * Empty one list, keeping everything else.
   *
   * "Clear all data" is the only bulk delete there was, and it takes the
   * fetched prices and the slab photographs with it — which is a heavy price
   * for fixing a list that went to the wrong tab. This removes the rows and
   * nothing else: the other list stays, and so do the snapshots, live quotes
   * and pictures, all of which are keyed by card and will still be there when
   * the right sheet is uploaded.
   */
  clearList(kind) {
    setState(kind === 'portfolio' ? { holdings: [] } : { watchlist: [] })
    scheduleSave(getState())
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

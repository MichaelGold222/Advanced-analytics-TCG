/**
 * Price providers.
 *
 * Lookups run in the browser, so they use the user's own network rather than a
 * server we would have to host, and no portfolio data is sent anywhere except
 * the card name being priced.
 *
 * Adding a provider means implementing `PriceProvider` and registering it.
 */
import type { PriceQuote } from './types'

export interface PriceLookup {
  name: string
  set?: string
  number?: string
}

export interface PriceProvider {
  id: string
  label: string
  /** True when this provider can price sealed product, not just singles. */
  coversSealed: boolean
  needsKey: boolean
  lookup(query: PriceLookup, signal?: AbortSignal): Promise<PriceQuote | null>
  /** One minimal request, to tell "cannot reach the API" from "no match". */
  test(signal?: AbortSignal): Promise<ConnectionResult>
}

export type ConnectionStatus = 'ok' | 'blocked' | 'rate_limited' | 'http_error'

export interface ConnectionResult {
  status: ConnectionStatus
  message: string
}

/**
 * A courtesy gap between requests. Measured against the live API, request
 * spacing made no difference to the failure rate (4/10 failures back to back,
 * 5/10 at 0.5s, 5/10 at 1.2s), so this is politeness, not a fix.
 */
const DEFAULT_MIN_REQUEST_GAP_MS = 250

/**
 * Backoff between retries.
 *
 * The API currently fails roughly half of all requests with 500 and 502,
 * regardless of rate, and those failures carry no Access-Control-Allow-Origin
 * header — so the browser discards them and hands page code a bare TypeError
 * with no status, which is indistinguishable from being blocked. Retrying is
 * the only thing that helps: at an observed ~50% failure rate, five attempts
 * bring a single lookup's chance of failing to about 3%.
 */
const DEFAULT_RETRY_DELAYS_MS = [500, 1200, 2500, 5000]

/** Request timing, in one place so it can be tuned or driven fast in tests. */
export const pricingTuning = {
  minRequestGapMs: DEFAULT_MIN_REQUEST_GAP_MS,
  retryDelaysMs: [...DEFAULT_RETRY_DELAYS_MS],
}

/** Total attempts per request: the first, plus one per backoff delay. */
export function maxAttempts(): number {
  return pricingTuning.retryDelaysMs.length + 1
}

let nextSlot = 0

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

/** Serialize requests onto a shared schedule, whatever calls them. */
async function takeSlot(signal?: AbortSignal): Promise<void> {
  const now = Date.now()
  const at = Math.max(now, nextSlot)
  nextSlot = at + pricingTuning.minRequestGapMs
  if (at > now) await sleep(at - now, signal)
}

/** Reset pacing, so a test or a fresh run does not inherit an old schedule. */
export function resetPacing(): void {
  nextSlot = 0
}

/**
 * Raised once retries are exhausted. The cause is genuinely ambiguous at this
 * point — sustained throttling and a blocked page produce the identical bare
 * TypeError — so the message names both rather than asserting one.
 */
export class PriceNetworkError extends Error {
  readonly blocked = true
  readonly provider: string
  constructor(provider: string) {
    super(
      `${provider} did not answer after ${maxAttempts()} attempts. This service currently fails about half of all requests with server errors, so some lookups failing is expected and retrying later usually works. It can also mean this page is not permitted to call outside services, or the network is down.`,
    )
    this.provider = provider
    this.name = 'PriceNetworkError'
  }
}

/** Escape a value for the Lucene-style query syntax the API uses. */
function q(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&').replace(/[:()[\]{}^~?]/g, ' ').trim()}"`
}

interface TcgPlayerPrices {
  [variant: string]: { low?: number; mid?: number; high?: number; market?: number; directLow?: number } | undefined
}

/** Variant preference when a card has several printings priced under one entry. */
const VARIANT_ORDER = [
  'normal', 'holofoil', 'reverseHolofoil', '1stEditionHolofoil', '1stEditionNormal',
  'unlimitedHolofoil', 'unlimited',
]

function pickVariant(prices: TcgPlayerPrices | undefined) {
  if (!prices) return null
  for (const v of VARIANT_ORDER) {
    const p = prices[v]
    if (p && (p.market != null || p.mid != null)) return { variant: v, ...p }
  }
  const first = Object.entries(prices).find(([, p]) => p && (p.market != null || p.mid != null))
  return first ? { variant: first[0], ...first[1]! } : null
}

export const pokemonTcgIo: PriceProvider = {
  id: 'pokemontcg.io',
  label: 'Pokémon TCG API (TCGplayer + Cardmarket)',
  coversSealed: false,
  needsKey: false,

  async test(signal) {
    try {
      // Through fetchCards, so the test exercises the same pacing and retries
      // the real lookups use and cannot report a transient refusal as a block.
      await fetchCards('name:"pikachu"', this.label, signal)
      return {
        status: 'ok' as const,
        message: 'Connected to the price API. Note that this service is currently unreliable — it fails roughly half of all requests — so a refresh retries each card up to 5 times and may still miss a few. Run it again to pick up the stragglers.',
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err
      if (err instanceof PriceNetworkError) {
        return {
          status: 'blocked' as const,
          message: isFileOrigin()
            ? 'This page was opened directly from a file, and browsers do not let a page opened that way call an outside service. That is the whole problem — the app and the price API are both fine. Serve the app over http instead (npm run serve), or set a price API address below.'
            : err.message,
        }
      }
      const message = err instanceof Error ? err.message : String(err)
      return {
        status: /refus|rate/i.test(message) ? ('rate_limited' as const) : ('http_error' as const),
        message,
      }
    }
  },

  async lookup(query, signal) {
    // Narrow first, then widen. ANDing name, set and number means one slightly
    // wrong set name returns nothing at all, which is indistinguishable from
    // the card not existing — and collection exports get set names wrong
    // constantly ("Base" for "Base Set", "SWSH Black Star" for "SWSH Promos").
    const name = `name:${q(query.name)}`
    const set = query.set ? `set.name:${q(query.set)}` : null
    const number = query.number ? `number:${q(String(query.number).replace(/^0+/, ''))}` : null

    const attempts = [
      [name, set, number],
      [name, set],
      [name, number],
      [name],
    ]
      .map((parts) => parts.filter(Boolean).join(' '))
      .filter((query, i, all) => query && all.indexOf(query) === i)

    let cards: RawCard[] = []
    for (const attempt of attempts) {
      cards = await fetchCards(attempt, this.label, signal)
      if (cards.length > 0) break
    }
    if (cards.length === 0) return null
    return toQuote(cards, this.id)
  },

}

async function fetchCards(query: string, label: string, signal?: AbortSignal): Promise<RawCard[]> {
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) await sleep(pricingTuning.retryDelaysMs[attempt - 1], signal)
    await takeSlot(signal)

    let res: Response
    try {
      res = await fetch(cardsUrl(query, 8), { signal, headers: apiKeyHeaders() })
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err
      // Either a genuine network failure or a refusal whose response the
      // browser dropped for want of a CORS header. Retrying separates them.
      if (attempt < pricingTuning.retryDelaysMs.length) continue
      throw new PriceNetworkError(label)
    }

    if (res.ok) {
      const body = (await res.json()) as { data?: unknown[] }
      return (body.data ?? []) as RawCard[]
    }
    // 429 and 5xx are what throttling looks like when the status does survive.
    if ((res.status === 429 || res.status >= 500) && attempt < pricingTuning.retryDelaysMs.length) continue
    throw new Error(
      res.status === 429 || res.status >= 500
        ? `The price API failed ${maxAttempts()} times for this card (HTTP ${res.status}). The service is currently unreliable; try again later.`
        : `Price API returned ${res.status}.`,
    )
  }
}

interface RawCard {
  name: string
  number?: string
  set?: { name?: string }
  tcgplayer?: { url?: string; updatedAt?: string; prices?: TcgPlayerPrices }
  cardmarket?: { url?: string; updatedAt?: string; prices?: { averageSellPrice?: number; lowPrice?: number; trendPrice?: number } }
}

const DIRECT_API = 'https://api.pokemontcg.io'

/**
 * Where to send price requests.
 *
 * Direct by default. Some hosts forbid a page from calling an outside service
 * at all, and the browser reports that identically to being offline — no
 * client-side change can talk its way past it. `npm run serve` therefore
 * serves the app with a same-origin proxy and stamps its path into this meta
 * tag, which removes the cross-origin call entirely.
 */
const API_BASE_STORAGE = 'aa-tcg.apiBase'

export function getApiBaseOverride(): string {
  try {
    return localStorage.getItem(API_BASE_STORAGE) ?? ''
  } catch {
    return ''
  }
}

export function setApiBaseOverride(base: string): void {
  try {
    if (base) localStorage.setItem(API_BASE_STORAGE, base)
    else localStorage.removeItem(API_BASE_STORAGE)
  } catch {
    /* storage unavailable; the override simply will not persist */
  }
}

export function apiBase(): string {
  const override = getApiBaseOverride()
  if (override) return override
  if (typeof document === 'undefined') return DIRECT_API
  const configured = document.querySelector('meta[name="price-api-base"]')?.getAttribute('content')
  return configured?.trim() || DIRECT_API
}

/**
 * True when this page was opened straight from disk.
 *
 * Such a page has no origin, and browsers forbid a page with no origin from
 * calling an outside service. Nothing the page does changes that, so naming it
 * is the only useful response — the generic "could not reach" message sends
 * people looking for a network fault that is not there.
 */
export function isFileOrigin(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'file:'
}

function cardsUrl(query: string, pageSize: number): string {
  const base = apiBase()
  const url = new URL(
    `${base.replace(/\/$/, '')}/v2/cards`,
    typeof location === 'undefined' ? DIRECT_API : location.href,
  )
  url.searchParams.set('q', query)
  url.searchParams.set('pageSize', String(pageSize))
  url.searchParams.set('orderBy', '-set.releaseDate')
  return url.toString()
}

function apiKeyHeaders(): Record<string, string> | undefined {
  const key = getApiKey()
  return key ? { 'X-Api-Key': key } : undefined
}

function toQuote(cards: RawCard[], providerId: string): PriceQuote | null {
  // Prefer a card that actually carries prices over a closer name match with none.
  const card = cards.find((c) => pickVariant(c.tcgplayer?.prices)) ?? cards[0]
  const tp = pickVariant(card.tcgplayer?.prices)
  if (tp) {
    return {
      low: tp.low, mid: tp.mid, high: tp.high, market: tp.market, directLow: tp.directLow,
      updatedAt: normalizeDate(card.tcgplayer?.updatedAt),
      currency: 'USD',
      provider: `${providerId} · TCGplayer ${tp.variant}`,
      url: card.tcgplayer?.url,
    }
  }
  const cm = card.cardmarket?.prices
  if (cm?.averageSellPrice != null || cm?.trendPrice != null) {
    return {
      low: cm.lowPrice, market: cm.trendPrice ?? cm.averageSellPrice, mid: cm.averageSellPrice,
      updatedAt: normalizeDate(card.cardmarket?.updatedAt),
      currency: 'EUR',
      provider: `${providerId} · Cardmarket`,
      url: card.cardmarket?.url,
    }
  }
  return null
}

/** The API reports "YYYY/MM/DD"; normalize so Date.parse agrees. */
function normalizeDate(d?: string): string | undefined {
  if (!d) return undefined
  return d.replace(/\//g, '-')
}

const API_KEY_STORAGE = 'aa-tcg.apiKey'

export function getApiKey(): string {
  try {
    return localStorage.getItem(API_KEY_STORAGE) ?? ''
  } catch {
    return ''
  }
}

export function setApiKey(key: string): void {
  try {
    if (key) localStorage.setItem(API_KEY_STORAGE, key)
    else localStorage.removeItem(API_KEY_STORAGE)
  } catch {
    /* storage unavailable (private mode); the key simply will not persist */
  }
}

export const PROVIDERS: PriceProvider[] = [pokemonTcgIo]

export interface RefreshTarget {
  key: string
  query: PriceLookup
  /**
   * Graded copies still get a quote — it is shown as context — but the price
   * describes a raw card, so it must never be recorded as this item's history.
   */
  graded?: boolean
  /** Sealed product is not priced by a singles API. */
  skipReason?: string
}

export interface RefreshOutcome {
  quotes: Map<string, PriceQuote>
  errors: { key: string; name: string; message: string }[]
  skipped: { key: string; name: string; reason: string }[]
  attempted: number
  /** Set when the page could not reach the provider at all. */
  blocked: string | null
}

/**
 * Fetch quotes with bounded concurrency. The public tier is rate limited, so
 * this stays deliberately gentle rather than firing a request per row at once.
 */
export async function refreshQuotes(
  targets: RefreshTarget[],
  provider: PriceProvider = pokemonTcgIo,
  opts: { concurrency?: number; onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<RefreshOutcome> {
  // Requests are serialized by the shared pacer regardless, so extra workers
  // would only queue behind each other.
  const concurrency = opts.concurrency ?? 1
  const quotes = new Map<string, PriceQuote>()
  const errors: RefreshOutcome['errors'] = []
  const skipped: RefreshOutcome['skipped'] = []
  let blocked: string | null = null

  const live = targets.filter((t) => {
    if (t.skipReason) {
      skipped.push({ key: t.key, name: t.query.name, reason: t.skipReason })
      return false
    }
    return true
  })

  let cursor = 0
  let done = 0
  async function worker() {
    while (cursor < live.length) {
      // A blocked page will block every request; stop rather than grinding
      // through the whole collection to collect the same failure N times.
      if (opts.signal?.aborted || blocked) return
      const target = live[cursor++]
      try {
        const quote = await provider.lookup(target.query, opts.signal)
        if (quote) quotes.set(target.key, quote)
        else errors.push({ key: target.key, name: target.query.name, message: 'No match found' })
      } catch (err) {
        if (opts.signal?.aborted) return
        if (err instanceof PriceNetworkError) {
          blocked = err.message
          return
        }
        errors.push({
          key: target.key,
          name: target.query.name,
          message: err instanceof Error ? err.message : String(err),
        })
      }
      opts.onProgress?.(++done, live.length)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, live.length) }, worker))
  return { quotes, errors, skipped, attempted: live.length, blocked }
}

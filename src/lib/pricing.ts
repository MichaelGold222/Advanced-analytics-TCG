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
 * A blocked request and a failed one are indistinguishable to `fetch`: both
 * arrive as a bare TypeError, because the browser withholds the reason from
 * page code. Naming the likely cause is the only useful thing to do with it.
 */
export class PriceNetworkError extends Error {
  readonly blocked = true
  readonly provider: string
  constructor(provider: string) {
    super(
      `Could not reach ${provider}. The page was stopped from making the request — either this page is not allowed to call outside services, or the network is down.`,
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
      const res = await fetch(cardsUrl('name:"pikachu"', 1), {
        signal,
        headers: apiKeyHeaders(),
      })
      if (res.status === 429) {
        return { status: 'rate_limited' as const, message: 'Reached the price API, but it is rate limiting this browser. Add a free API key below, or wait a minute.' }
      }
      if (!res.ok) {
        return { status: 'http_error' as const, message: `Reached the price API, but it answered ${res.status}. That is a problem on their end; try again later.` }
      }
      await res.json()
      return { status: 'ok' as const, message: 'Connected to the price API. Lookups should work — anything still unpriced is a name that did not match, a graded card, or sealed product.' }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err
      return {
        status: 'blocked' as const,
        message: new PriceNetworkError(this.label).message,
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
  let res: Response
  try {
    res = await fetch(cardsUrl(query, 8), { signal, headers: apiKeyHeaders() })
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    throw new PriceNetworkError(label)
  }
  if (!res.ok) {
    throw new Error(
      res.status === 429
        ? 'Rate limited by the price API — add a free API key in Data & settings.'
        : `Price API returned ${res.status}.`,
    )
  }
  const body = (await res.json()) as { data?: unknown[] }
  return (body.data ?? []) as RawCard[]
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
export function apiBase(): string {
  if (typeof document === 'undefined') return DIRECT_API
  const configured = document.querySelector('meta[name="price-api-base"]')?.getAttribute('content')
  return configured?.trim() || DIRECT_API
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
  const concurrency = opts.concurrency ?? 3
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

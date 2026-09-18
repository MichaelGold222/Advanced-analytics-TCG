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

  async lookup(query, signal) {
    const parts = [`name:${q(query.name)}`]
    if (query.set) parts.push(`set.name:${q(query.set)}`)
    if (query.number) parts.push(`number:${q(String(query.number).replace(/^0+/, ''))}`)

    const url = new URL('https://api.pokemontcg.io/v2/cards')
    url.searchParams.set('q', parts.join(' '))
    url.searchParams.set('pageSize', '8')
    url.searchParams.set('orderBy', '-set.releaseDate')

    const key = getApiKey()
    const res = await fetch(url, {
      signal,
      headers: key ? { 'X-Api-Key': key } : undefined,
    })
    if (!res.ok) {
      throw new Error(`${this.label} returned ${res.status}${res.status === 429 ? ' (rate limited — add a free API key in Settings)' : ''}`)
    }
    const body = (await res.json()) as { data?: unknown[] }
    const cards = (body.data ?? []) as {
      name: string
      number?: string
      set?: { name?: string }
      tcgplayer?: { url?: string; updatedAt?: string; prices?: TcgPlayerPrices }
      cardmarket?: { url?: string; updatedAt?: string; prices?: { averageSellPrice?: number; lowPrice?: number; trendPrice?: number } }
    }[]
    if (cards.length === 0) return null

    // Prefer a card that actually carries prices over a closer name match with none.
    const card = cards.find((c) => pickVariant(c.tcgplayer?.prices)) ?? cards[0]
    const tp = pickVariant(card.tcgplayer?.prices)
    if (tp) {
      return {
        low: tp.low, mid: tp.mid, high: tp.high, market: tp.market, directLow: tp.directLow,
        updatedAt: normalizeDate(card.tcgplayer?.updatedAt),
        currency: 'USD',
        provider: `${this.id} · TCGplayer ${tp.variant}`,
        url: card.tcgplayer?.url,
      }
    }
    const cm = card.cardmarket?.prices
    if (cm?.averageSellPrice != null || cm?.trendPrice != null) {
      return {
        low: cm.lowPrice, market: cm.trendPrice ?? cm.averageSellPrice, mid: cm.averageSellPrice,
        updatedAt: normalizeDate(card.cardmarket?.updatedAt),
        currency: 'EUR',
        provider: `${this.id} · Cardmarket`,
        url: card.cardmarket?.url,
      }
    }
    return null
  },
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
  /** Sealed product and graded slabs are not priced by a singles API. */
  skipReason?: string
}

export interface RefreshOutcome {
  quotes: Map<string, PriceQuote>
  errors: { key: string; name: string; message: string }[]
  skipped: { key: string; name: string; reason: string }[]
  attempted: number
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
      if (opts.signal?.aborted) return
      const target = live[cursor++]
      try {
        const quote = await provider.lookup(target.query, opts.signal)
        if (quote) quotes.set(target.key, quote)
        else errors.push({ key: target.key, name: target.query.name, message: 'No match found' })
      } catch (err) {
        if (opts.signal?.aborted) return
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
  return { quotes, errors, skipped, attempted: live.length }
}

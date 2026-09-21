/**
 * Card Ladder, reached through Parse.
 *
 * Shapes here were read from live responses (see .github/workflows/api-check.yml),
 * not from documentation alone. A sale record looks like:
 *
 *   { "date": "2026-09-07T03:19:00.000Z", "price": 21000,
 *     "url": "https://www.ebay.com/itm/287456192405", "type": "Auction" }
 *
 * and a bulk cert result like:
 *
 *   { "cert_number": "93083876", "grading_company": "PSA",
 *     "last_sale_price": 21000, "cl_value": 21911.69, "recent_sales": [ ... ] }
 *
 * These are completed sales of that exact card at that exact grade, which is
 * what the median-of-recent-sales valuation is built on.
 */
import { toISODate } from '../stats'
import type { PricePoint } from '../types'

/** Graders the bulk cert endpoint accepts; anything else is rejected upstream. */
export const SUPPORTED_GRADERS = ['PSA', 'BGS', 'CGC', 'SGC'] as const
export type SupportedGrader = (typeof SUPPORTED_GRADERS)[number]

/** The endpoint accepts at most 200 cert/grader pairs per request. */
export const MAX_CERTS_PER_CALL = 200

/**
 * Concurrent calls the client runs.
 *
 * A collection is split into three calls, so three is all that is ever needed
 * to run them at once. Holding it there also keeps a degraded upstream, where
 * a timed-out call is split and retried, from putting a crowd of requests in
 * flight against an allowance of 5 a minute.
 */
export const FETCH_CONCURRENCY = 3

/**
 * Smallest call worth making.
 *
 * Every call costs the same three credits, one of the day's hundred requests,
 * and about two seconds of fixed overhead, so splitting a small collection
 * finely spends all three on nothing.
 */
export const MIN_BATCH_SIZE = 25

/** Credits one call costs, whatever its size. Observed live. */
export const CREDITS_PER_CALL = 3

/** Fixed cost of a call before any cert is priced, in ms. */
export const CALL_OVERHEAD_MS = 2000

/** Marginal cost of one more cert in the same call, in ms. */
export const MS_PER_CERT = 600

export interface CardLadderSale {
  date?: string
  price?: number
  url?: string
  type?: string
  platform?: string
}

export interface CertResult {
  cert_number?: string
  grading_company?: string
  last_sale_price?: number
  cl_value?: number
  recent_sales?: CardLadderSale[]
}

export interface BulkResponse {
  status?: string
  data?: { results?: CertResult[]; errors?: unknown[]; total?: number }
}

export interface CertRequest {
  cert_number: string
  grading_company: SupportedGrader
}

export function isSupportedGrader(g: string | null | undefined): g is SupportedGrader {
  return !!g && (SUPPORTED_GRADERS as readonly string[]).includes(g.toUpperCase())
}

/** Split into request-sized batches, since one call covers at most 200 certs. */
export function batchCerts(certs: CertRequest[], size = planBatchSize(certs.length)): CertRequest[][] {
  const step = Math.max(1, Math.min(Math.floor(size) || 1, MAX_CERTS_PER_CALL))
  const out: CertRequest[][] = []
  for (let i = 0; i < certs.length; i += step) out.push(certs.slice(i, i + step))
  return out
}

/**
 * Convert sale records to price points.
 *
 * Every one is a completed transaction, so all are `sale` — the source the
 * valuation takes a median over. Records without a usable date and a positive
 * price are dropped rather than guessed at.
 */
/**
 * Which marketplace a sale happened on, from its link.
 *
 * Kept because the venues are not interchangeable: an auction-house result
 * carries a buyer's premium and a different audience, so "what it last sold
 * for on eBay" is a question the data can only answer if this survives.
 */
export function venueOf(sale: CardLadderSale): string | undefined {
  const raw = sale.platform ?? sale.url
  if (!raw) return undefined
  const host = /^https?:/i.test(raw) ? (raw.split('/')[2] ?? '') : raw
  const h = host.toLowerCase()
  if (h.includes('ebay')) return 'ebay'
  if (h.includes('fanatics')) return 'fanatics'
  if (h.includes('goldin')) return 'goldin'
  if (h.includes('pwcc')) return 'pwcc'
  if (h.includes('heritage') || h.includes('ha.com')) return 'heritage'
  return h.replace(/^www\./, '') || undefined
}

export function salesToPricePoints(sales: CardLadderSale[] | undefined): PricePoint[] {
  if (!Array.isArray(sales)) return []
  const seen = new Set<string>()
  const points: PricePoint[] = []
  for (const s of sales) {
    if (typeof s?.price !== 'number' || !Number.isFinite(s.price) || s.price <= 0) continue
    const date = s.date ? toISODate(s.date) : ''
    if (!date) continue
    // The same sale can appear twice across overlapping responses.
    const sig = `${date}|${s.price}`
    if (seen.has(sig)) continue
    seen.add(sig)
    points.push({ date, price: s.price, source: 'sale', venue: venueOf(s) })
  }
  return points.sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Fold a freshly fetched sales list into the one already held.
 *
 * The bulk endpoint returns only the newest few sales per certificate — five,
 * measured against the live API — so its window slides forward as the card
 * trades. Replacing the stored list with each response therefore threw away
 * every sale that had aged out of it: after three fetches the app knew less
 * about a busy card than it had after one, and the "52-week high" was the high
 * of whatever the last few weeks happened to contain.
 *
 * Keeping the union costs nothing and the record only deepens. Duplicates come
 * back on every call by construction, so they are matched on date and price —
 * the same pair the parser already dedupes within one response.
 */
export function mergeSalePoints(existing: PricePoint[], incoming: PricePoint[]): PricePoint[] {
  const seen = new Set<string>()
  const out: PricePoint[] = []
  for (const p of [...existing, ...incoming]) {
    const sig = `${p.date}|${p.price}`
    if (seen.has(sig)) continue
    seen.add(sig)
    out.push(p)
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

export interface CertPrices {
  cert: string
  grader: string
  points: PricePoint[]
  /** Card Ladder's own value. Kept for display; it is not a sale. */
  clValue: number | null
  lastSalePrice: number | null
}

/** Read one bulk response into per-cert price history. */
export function parseBulkResponse(body: unknown): CertPrices[] {
  const results = (body as BulkResponse)?.data?.results
  if (!Array.isArray(results)) return []
  const out: CertPrices[] = []
  for (const r of results) {
    const cert = String(r?.cert_number ?? '').trim()
    if (!cert) continue
    out.push({
      cert,
      grader: String(r?.grading_company ?? '').toUpperCase(),
      points: salesToPricePoints(r?.recent_sales),
      clValue: typeof r?.cl_value === 'number' && r.cl_value > 0 ? r.cl_value : null,
      lastSalePrice:
        typeof r?.last_sale_price === 'number' && r.last_sale_price > 0 ? r.last_sale_price : null,
    })
  }
  return out
}

/** The file the scheduled fetch writes and the dashboard reads. */
export interface PriceFeed {
  fetchedAt: string
  source: string
  byCert: Record<string, { grader: string; clValue: number | null; lastSalePrice: number | null; sales: PricePoint[] }>
  errors: { cert: string; message: string }[]
}

/**
 * Fold a new run's results into the feed the last run wrote.
 *
 * Without this a scheduled fetch is pointless. The upstream returns only the
 * newest few sales per cert, so writing the response straight out means the
 * file holds a sliding window of the last few weeks and nothing before it —
 * running it weekly for a year would leave exactly as little history as
 * running it once. Merged, the file is a record that only ever deepens, and
 * after twelve months the 52-week high in it is a real one.
 *
 * A cert absent from the new run keeps whatever the old file held: a bad
 * night upstream must not delete history that was already paid for. Its
 * metadata is only replaced when the new run actually has a figure.
 */
export function mergeFeeds(previous: PriceFeed | null, next: PriceFeed): PriceFeed {
  if (!previous?.byCert) return next
  const byCert: PriceFeed['byCert'] = { ...previous.byCert }
  for (const [cert, entry] of Object.entries(next.byCert)) {
    const old = byCert[cert]
    byCert[cert] = {
      grader: entry.grader || old?.grader || '',
      clValue: entry.clValue ?? old?.clValue ?? null,
      lastSalePrice: entry.lastSalePrice ?? old?.lastSalePrice ?? null,
      sales: mergeSalePoints(old?.sales ?? [], entry.sales),
    }
  }
  return { ...next, byCert }
}

export function buildFeed(entries: CertPrices[], errors: PriceFeed['errors'] = []): PriceFeed {
  const byCert: PriceFeed['byCert'] = {}
  for (const e of entries) {
    byCert[e.cert] = {
      grader: e.grader,
      clValue: e.clValue,
      lastSalePrice: e.lastSalePrice,
      sales: e.points,
    }
  }
  return {
    fetchedAt: new Date().toISOString(),
    source: 'Card Ladder via Parse',
    byCert,
    errors,
  }
}



/**
 * How many calls a whole collection should take.
 *
 * The scarce thing is requests, not time. The plan allows 100 requests a day
 * and charges three credits per price call, so a split that halves the wait
 * triples both bills — and running out of either stops the collection being
 * priced at all, which no amount of speed makes up for.
 *
 * Three calls prices ninety slabs in about twenty seconds for nine credits and
 * three requests. Splitting the same ninety into six would cost eighteen
 * credits and six requests to save nine seconds.
 */
export const TARGET_CALLS = 3

/**
 * How to split a collection into calls.
 *
 * Aims for TARGET_CALLS, which all run at once, so the wait is the length of
 * one call however large the collection. The floor stops a small collection
 * from buying calls it has no use for, and the ceiling is the endpoint's own
 * limit.
 */
export function planBatchSize(certCount: number, targetCalls = TARGET_CALLS): number {
  if (certCount <= 0) return MIN_BATCH_SIZE
  const even = Math.ceil(certCount / Math.max(1, targetCalls))
  return Math.max(MIN_BATCH_SIZE, Math.min(even, MAX_CERTS_PER_CALL))
}

/**
 * How long pricing this many certs should take, and what it should cost.
 *
 * Built from the measured shape above rather than a guess, so the estimate on
 * screen matches what actually happens.
 */
export function estimateFetch(
  certCount: number,
  batchSize = planBatchSize(certCount),
  concurrency = FETCH_CONCURRENCY,
): { ms: number; credits: number; calls: number } {
  if (certCount <= 0) return { ms: 0, credits: 0, calls: 0 }
  const size = Math.max(1, Math.min(batchSize, MAX_CERTS_PER_CALL))
  const calls = Math.ceil(certCount / size)
  // The last call may be short; the wave is only as slow as its longest.
  const perCall = CALL_OVERHEAD_MS + Math.min(size, certCount) * MS_PER_CERT
  const waves = Math.ceil(calls / Math.max(1, concurrency))
  return { ms: waves * perCall, credits: calls * CREDITS_PER_CALL, calls }
}

export interface CertImage {
  cert: string
  /** Full-size picture: the card, or the listing photo of the slab. */
  image: string | null
  /** Smaller version of the same, which is what a table row wants. */
  thumbnail: string | null
  /**
   * Sales the search returned alongside the pictures.
   *
   * Measured: for cert 141142901 this call returned **ten** sales where the
   * three-credit price call returned five, and the price call dated all five
   * to the day of the request — a 0-day span — while these carried real dates
   * across nine. Deeper, better dated, a third of the credits, and the app was
   * already making the call for the photographs and throwing the sales away.
   */
  sales: PricePoint[]
}

/** Only pictures served over https are worth carrying into the page. */
function httpsUrl(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  return s.startsWith('https://') ? s : null
}

/**
 * Read pictures out of a bulk cert search.
 *
 * Results are keyed by the certificate they answer for where the upstream
 * says so, and fall back to request order where it does not — a picture on
 * the wrong card is worse than no picture, so the order is only trusted when
 * the count matches exactly.
 */
export function parseCertImages(body: unknown, asked: CertRequest[]): CertImage[] {
  const results = (body as { data?: { results?: unknown[] } })?.data?.results
  if (!Array.isArray(results)) return []

  const rows = results.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
  const named = rows.filter((r) => String(r.cert_number ?? '').trim() !== '')
  const positional = named.length === 0 && rows.length === asked.length

  const out: CertImage[] = []
  rows.forEach((r, i) => {
    const cert = positional ? asked[i].cert_number : String(r.cert_number ?? '').trim()
    if (!cert) return
    const image = httpsUrl(r.image)
    const thumbnail = httpsUrl(r.thumbnail)
    const sales = salesToPricePoints(r.recent_sales as CardLadderSale[] | undefined)
    // A row with sales and no photograph is still worth keeping now.
    if (!image && !thumbnail && sales.length === 0) return
    out.push({ cert, image, thumbnail, sales })
  })
  return out
}

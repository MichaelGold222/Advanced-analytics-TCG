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
 * The account allows a burst of 30 requests refilling at 5/min. Eight in
 * flight stays well inside that while cutting the wall clock eightfold, and
 * the client backs off and retries if a burst is spent anyway.
 */
export const FETCH_CONCURRENCY = 8

/**
 * Smallest call worth making.
 *
 * Every call costs the same three credits and about two seconds of fixed
 * overhead, so splitting a small collection finely spends both on nothing.
 */
export const MIN_BATCH_SIZE = 15

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
    points.push({ date, price: s.price, source: 'sale' })
  }
  return points.sort((a, b) => a.date.localeCompare(b.date))
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
 * How to split a collection into calls.
 *
 * Calls run concurrently, so the wall clock is the size of one call, not the
 * size of the collection — provided they all fit in a single wave. Splitting
 * into exactly as many calls as run at once therefore prices any collection in
 * one call's worth of time, and for a fixed number of calls the credit cost is
 * fixed too, whether the collection is 90 slabs or 400.
 *
 * The floor stops a small collection from buying eight calls it does not need,
 * and the ceiling is the endpoint's own limit, past which a second wave is
 * unavoidable.
 */
export function planBatchSize(certCount: number, concurrency = FETCH_CONCURRENCY): number {
  if (certCount <= 0) return MIN_BATCH_SIZE
  const even = Math.ceil(certCount / Math.max(1, concurrency))
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

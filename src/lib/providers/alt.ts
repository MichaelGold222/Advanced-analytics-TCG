/**
 * Alt (alt.xyz), keyed on the certificate number.
 *
 * The reason this exists: Card Ladder's wrapper reaches a card only through a
 * card id, and 31 of 32 certificates in this collection cannot produce one —
 * a promo is not in the catalogue collection it reads, so its history is
 * unobtainable there at any price. Alt indexes by certificate, which this app
 * already holds for every row, so there is no catalogue lookup to fail.
 *
 * Measured against the live API for cert 77865285, a 2019 Japanese SM promo
 * Card Ladder could not touch at all:
 *
 *   sales_count      1422
 *   spans            2020-09-13 to 2026-09-19
 *   last 12 months   $198 - $1,000 from 394 sales
 *   charged          2 credits
 *
 * The app's own figure for that card at the time was $462-$568 "over 57 days",
 * from the five sales the other feed returns. The real yearly high was $1,000:
 * wrong by 43%, because a five-sale window happened to land on a quiet stretch.
 *
 * These are INDIVIDUAL sales, not the aggregated {date, price, count} rows
 * Card Ladder serves, so a high here is the actual high rather than a floor on
 * one. Each carries the auction house and a link to the listing.
 */
import type { PricePoint } from '../types'

/**
 * How much history to keep.
 *
 * Alt returns everything it has — 1,422 sales back to 2020 for one card — and
 * there is no date parameter, so asking for less does not cost less. The
 * reason to trim is what happens afterwards: 32 cards at that depth is some
 * forty-five thousand points in the browser's store, walked by every analysis,
 * every repeat-sales pair and every simulation. Two years is about twelve
 * thousand, which stays quick.
 *
 * Two years is also the longest window anything here reports, and a 2020 peak
 * is a poor reference for a buy decision today. The cost of the trim, stated
 * plainly: the "all-time" high becomes the two-year high, so a card that
 * peaked before that reads as nearer its top than it is.
 */
export const KEEP_YEARS = 2

/** Measured: 2 credits for one certificate, 1,422 sales. */
export const ALT_CREDITS_PER_LOOKUP = 2

export interface AltCert {
  cert: string
  /** Every completed sale Alt holds for this card at this grade. */
  sales: PricePoint[]
  /** Alt's own valuation, kept for display; it is not a sale. */
  altValue: number | null
  /** Graded population — exogenous, and the model has wanted it for a while. */
  population: number | null
  /**
   * Every sale Alt says it holds, including the ones older than `KEEP_YEARS`
   * that were not kept — so "1,422 on record, 394 kept" is visible rather
   * than looking like a short response.
   */
  salesCount: number | null
  /** Alt's name for the card, which is fuller than most sheets carry. */
  name: string | null
  /** A photograph, free in the same response. */
  image: string | null
  /** False when Alt reported this certificate as not found. */
  found: boolean
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/** Alt dates arrive ISO; keep the day and drop the time. */
function isoDay(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) return ''
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

/**
 * Sales out of one Alt record.
 *
 * `subject_to_change` marks a sale Alt has not settled — an auction result
 * that may still be revised. Kept, because excluding it would quietly drop the
 * most recent sales, which are the ones a band most needs; the flag rides
 * along so it can be reconsidered if those turn out to move.
 */
export function altSales(node: unknown, now = new Date()): PricePoint[] {
  const rows = (node as { sales?: unknown[] })?.sales
  if (!Array.isArray(rows)) return []
  const cutoff = new Date(now.getTime() - KEEP_YEARS * 365.25 * 86_400_000)
    .toISOString().slice(0, 10)
  const seen = new Set<string>()
  const out: PricePoint[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const row = r as Record<string, unknown>
    const price = num(row.price)
    const date = isoDay(row.date)
    if (!price || !date) continue
    if (date < cutoff) continue
    const sig = `${date}|${price}`
    if (seen.has(sig)) continue
    seen.add(sig)
    const house = typeof row.auction_house === 'string' ? row.auction_house.trim() : ''
    out.push({ date, price, source: 'sale', venue: house || undefined })
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * One record, as `lookup_certs` actually returns them. Measured, run 3:
 *
 * ```
 * data.results[] = { cert_number, status, error, data: {
 *     cert:       { cert_number, grading_company, grade_number, ... }
 *     asset:      { asset_id, name, subject, brand, variety, card_number, image_url }
 *     alt_value:  { current, confidence_metric, lower_bound, ... }
 *     population: [ { grading_company, grade_number, count } ]   // every grade
 *     sales:      [ { id, date, price, auction_house, auction_type,
 *                     grade_number, listing_url, subject_to_change } ]
 *     sales_count: 1422 } }
 * ```
 *
 * The payload is nested under a second `data`, and `population` is a list
 * covering every grade rather than a number. The first reader here was
 * written against neither — it looked for list items carrying `sales`
 * directly — so it walked past 1,422 sales a card and reported "nothing for
 * 32 certificates" after calls that had all succeeded.
 */
export function parseAltCert(node: unknown, fallbackCert: string, now = new Date()): AltCert | null {
  if (!node || typeof node !== 'object') return null
  const outer = node as Record<string, unknown>
  // `lookup_cert` answers { data: {...} }; a `lookup_certs` result answers
  // { cert_number, status, data: {...} }. Unwrap either.
  const inner = (outer.data && typeof outer.data === 'object' ? outer.data : outer) as Record<string, unknown>

  const certNode = inner.cert as Record<string, unknown> | undefined
  const cert = String(outer.cert_number ?? certNode?.cert_number ?? inner.cert_number ?? fallbackCert ?? '').trim()
  if (!cert) return null

  // The certificate alone is not evidence of a record: it can come from the
  // list of certs that were ASKED about. A row carrying none of the fields a
  // real record has is something this cannot read, and returning a card with
  // no sales for it would mark the certificate fetched and never retry it.
  const recognised = certNode != null || Array.isArray(inner.sales)
    || inner.asset != null || inner.alt_value != null || inner.sales_count != null
  if (!recognised) return null

  const asset = inner.asset as Record<string, unknown> | undefined
  const altValue = inner.alt_value as Record<string, unknown> | number | undefined

  return {
    cert,
    sales: altSales(inner, now),
    altValue: typeof altValue === 'number' ? num(altValue) : num(altValue?.current),
    population: populationFor(inner.population, certNode),
    salesCount: typeof inner.sales_count === 'number' ? inner.sales_count : null,
    name: typeof asset?.name === 'string' ? asset.name : null,
    image: typeof asset?.image_url === 'string' && asset.image_url.startsWith('https://')
      ? asset.image_url : null,
    found: outer.status == null || outer.status === 'found',
  }
}

/**
 * The population at THIS card's grade.
 *
 * `population` lists every grade — 59 entries for one card — so taking the
 * first, or a total, would report the wrong number. Grades arrive as `10.0`
 * in one place and `"10.0"` in another, hence the loose compare.
 */
export function populationFor(list: unknown, cert: Record<string, unknown> | undefined): number | null {
  if (!Array.isArray(list)) return num(list)
  const grade = Number(cert?.grade_number)
  const company = String(cert?.grading_company ?? '').toUpperCase()
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const sameGrade = Number.isFinite(grade) && Number(r.grade_number) === grade
    const sameCompany = !company || String(r.grading_company ?? '').toUpperCase() === company
    if (sameGrade && sameCompany) return num(r.count)
  }
  return null
}

/**
 * What Alt itself says it did, straight out of the response.
 *
 * The distinction that has cost two rounds: "Alt had nothing for 32
 * certificates" reads identically whether Alt found nothing or whether it
 * found everything and the reader could not understand it. Alt counts its own
 * results, so the answer is in the payload and there is no need to guess.
 */
export interface AltCounts {
  requested: number | null
  found: number | null
  notFound: number | null
  errors: number | null
}

export function altCounts(body: unknown): AltCounts {
  const d = (body as { data?: Record<string, unknown> })?.data ?? {}
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    requested: n(d.requested_count),
    found: n(d.found_count),
    notFound: n(d.not_found_count),
    errors: n(d.error_count),
  }
}

/** A whole `lookup_certs` response. */
export function parseAltCerts(body: unknown, asked: string[], now = new Date()): AltCert[] {
  const data = (body as { data?: unknown })?.data
  const rows = (data as { results?: unknown })?.results
  const list = Array.isArray(rows) ? rows : Array.isArray(data) ? data : null

  const out: AltCert[] = []
  const seen = new Set<string>()
  const take = (node: unknown, fallback: string) => {
    const one = parseAltCert(node, fallback, now)
    if (one && one.found && !seen.has(one.cert)) { seen.add(one.cert); out.push(one) }
  }

  if (list) {
    list.forEach((row, i) => take(row, asked[i] ?? ''))
  } else if (data && typeof data === 'object') {
    // A single record, or a map of cert -> record.
    const d = data as Record<string, unknown>
    if ('sales' in d || 'cert' in d) take(d, asked[0] ?? '')
    else for (const [k, v] of Object.entries(d)) take(v, k)
  }
  return out
}

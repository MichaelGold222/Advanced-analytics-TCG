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
  /** What Alt says it holds, so a truncated response is visible as one. */
  salesCount: number | null
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
export function altSales(node: unknown): PricePoint[] {
  const rows = (node as { sales?: unknown[] })?.sales
  if (!Array.isArray(rows)) return []
  const seen = new Set<string>()
  const out: PricePoint[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const row = r as Record<string, unknown>
    const price = num(row.price)
    const date = isoDay(row.date)
    if (!price || !date) continue
    const sig = `${date}|${price}`
    if (seen.has(sig)) continue
    seen.add(sig)
    const house = typeof row.auction_house === 'string' ? row.auction_house.trim() : ''
    out.push({ date, price, source: 'sale', venue: house || undefined })
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

/** One `lookup_cert` or one entry of a `lookup_certs` response. */
export function parseAltCert(node: unknown, fallbackCert: string): AltCert | null {
  const data = (node as { data?: unknown })?.data ?? node
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const certNode = d.cert as Record<string, unknown> | undefined
  const cert = String(certNode?.cert_number ?? d.cert_number ?? fallbackCert ?? '').trim()
  if (!cert) return null

  const pop = d.population
  return {
    cert,
    sales: altSales(d),
    altValue: num(d.alt_value) ?? num((d.alt_value as Record<string, unknown>)?.value),
    population: typeof pop === 'number' && Number.isFinite(pop)
      ? pop
      : num((pop as Record<string, unknown>)?.total ?? (pop as Record<string, unknown>)?.count),
    salesCount: typeof d.sales_count === 'number' ? d.sales_count : null,
  }
}

/** A `lookup_certs` response, which may nest its results under any key. */
export function parseAltCerts(body: unknown, asked: string[]): AltCert[] {
  const data = (body as { data?: unknown })?.data
  const out: AltCert[] = []
  const seen = new Set<string>()

  const take = (node: unknown, fallback: string) => {
    const one = parseAltCert(node, fallback)
    if (one && !seen.has(one.cert)) { seen.add(one.cert); out.push(one) }
  }

  if (Array.isArray(data)) {
    data.forEach((row, i) => take(row, asked[i] ?? ''))
  } else if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    // Either a list under some key, or a map of cert -> record.
    const list = Object.values(d).find((v) => Array.isArray(v) && v.some((x) => x && typeof x === 'object' && 'sales' in (x as object)))
    if (Array.isArray(list)) {
      list.forEach((row, i) => take(row, asked[i] ?? ''))
    } else if ('sales' in d) {
      take(d, asked[0] ?? '')
    } else {
      for (const [k, v] of Object.entries(d)) take(v, k)
    }
  }
  return out
}

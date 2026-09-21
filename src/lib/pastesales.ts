/**
 * Read a sales table out of whatever someone pasted.
 *
 * Some cards cannot be reached through the API at any price. Card Ladder
 * stores promos outside the `cards` collection the Parse wrapper looks in, so
 * a Japanese promo answers 422 even when given its own Card Ladder id, taken
 * from the site's own URL. No query, no certificate and no id reaches it.
 *
 * The owner can see those sales perfectly well on a subscription they already
 * pay for. So the route is to let them paste what they are looking at, which
 * costs nothing and works for every card regardless of coverage.
 *
 * Deliberately forgiving about shape, because a paste is whatever the source
 * happened to lay out: tabs, multiple spaces, commas, a currency symbol, a
 * thousands separator, a date in any of the usual orders, and any number of
 * columns around the two that matter. It finds a date and a price on a line
 * and ignores everything else on it.
 *
 * It never guesses silently: every line comes back either parsed or rejected
 * with a reason, so what lands is what the person saw and agreed to.
 */
import { toISODate } from './stats'
import type { PricePoint } from './types'

export interface ParsedLine {
  line: string
  date: string | null
  price: number | null
  /** Why the line was not usable, when it was not. */
  problem: string | null
}

export interface PasteResult {
  points: PricePoint[]
  lines: ParsedLine[]
  accepted: number
  rejected: number
}

/** Dates in the orders these sources actually use. */
const DATE_PATTERNS: RegExp[] = [
  /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/,                          // 2026-09-14
  /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,                        // 9/14/2026
  /\b(\d{1,2})\/(\d{1,2})\/(\d{2})\b/,                        // 9/14/26
  /\b([A-Z][a-z]{2,8})\.?\s+(\d{1,2}),?\s+(\d{4})\b/,         // Sep 14, 2026
  /\b(\d{1,2})\s+([A-Z][a-z]{2,8})\.?\s+(\d{4})\b/,           // 14 Sep 2026
]

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

function isoFrom(match: RegExpMatchArray, which: number): string | null {
  const [, a, b, c] = match
  let y: number, m: number, d: number
  if (which === 0) { y = +a; m = +b; d = +c }
  else if (which === 1 || which === 2) {
    m = +a; d = +b
    // A two-digit year is this century: these are sales records, not antiques.
    y = which === 2 ? 2000 + +c : +c
  } else if (which === 3) { m = MONTHS[a.slice(0, 3).toLowerCase()] ?? 0; d = +b; y = +c }
  else { d = +a; m = MONTHS[b.slice(0, 3).toLowerCase()] ?? 0; y = +c }
  if (!y || !m || !d || m > 12 || d > 31) return null
  const iso = toISODate(new Date(Date.UTC(y, m - 1, d)))
  return iso || null
}

function findDate(line: string): string | null {
  for (let i = 0; i < DATE_PATTERNS.length; i++) {
    const m = line.match(DATE_PATTERNS[i])
    if (m) {
      const iso = isoFrom(m, i)
      if (iso) return iso
    }
  }
  return null
}

/**
 * The price on the line, which is not simply the first number.
 *
 * A row usually carries a grade, a quantity and a certificate number as well,
 * so a currency-marked figure wins, then the largest plausible number. A bare
 * "10" beside "$525" is the grade, not the price.
 */
function findPrice(line: string, without: string): number | null {
  const rest = line.replace(without, ' ')
  const marked = [...rest.matchAll(/[$£€]\s?([\d,]+(?:\.\d{1,2})?)/g)]
    .map((m) => Number(m[1].replace(/,/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0)
  if (marked.length > 0) return Math.max(...marked)

  const bare = [...rest.matchAll(/\b(\d[\d,]*(?:\.\d{1,2})?)\b/g)]
    .map((m) => Number(m[1].replace(/,/g, '')))
    // Below a dollar is noise — a grade, a count, a page number.
    .filter((n) => Number.isFinite(n) && n >= 1)
  return bare.length > 0 ? Math.max(...bare) : null
}

export function parsePastedSales(text: string, now = new Date()): PasteResult {
  const lines: ParsedLine[] = []
  const points: PricePoint[] = []
  const seen = new Set<string>()
  const todayIso = toISODate(now)

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue

    const date = findDate(line)
    if (!date) {
      lines.push({ line, date: null, price: null, problem: 'no date on this line' })
      continue
    }
    if (date > todayIso) {
      lines.push({ line, date, price: null, problem: `${date} is in the future` })
      continue
    }
    const price = findPrice(line, line.match(DATE_PATTERNS.find((p) => p.test(line))!)?.[0] ?? '')
    if (price == null) {
      lines.push({ line, date, price: null, problem: 'no price on this line' })
      continue
    }

    const sig = `${date}|${price}`
    if (seen.has(sig)) {
      lines.push({ line, date, price, problem: 'same date and price as an earlier line' })
      continue
    }
    seen.add(sig)
    lines.push({ line, date, price, problem: null })
    // `user`, not `sale`: it is a price on a date that the owner vouches for,
    // which is what the band needs, but it was not fetched and should not be
    // passed off as a completed sale the app observed.
    points.push({ date, price, source: 'user' })
  }

  points.sort((a, b) => a.date.localeCompare(b.date))
  const accepted = lines.filter((l) => l.problem == null).length
  return { points, lines, accepted, rejected: lines.length - accepted }
}

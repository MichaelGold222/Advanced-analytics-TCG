/** Coercion helpers for messy spreadsheet cells. */
import { toISODate } from './stats'

/** Parse a money-ish cell: "$1,234.50", "(45)" for negatives, "1 234,50". */
export function toNumber(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'boolean') return undefined
  let s = String(v).trim()
  if (!s) return undefined
  const negated = /^\(.*\)$/.test(s)
  if (negated) s = s.slice(1, -1)
  s = s.replace(/[^0-9.,-]/g, '')
  if (!s) return undefined
  // "1.234,50" (European) vs "1,234.50" (US): the last separator is the decimal.
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.')
  else s = s.replace(/,/g, '')
  const n = Number.parseFloat(s)
  if (!Number.isFinite(n)) return undefined
  return negated ? -n : n
}

export function toText(v: unknown): string | undefined {
  if (v == null) return undefined
  if (v instanceof Date) return toISODate(v)
  const s = String(v).trim()
  return s || undefined
}

/** Excel's serial-date epoch, with the deliberate 1900 leap-year bug baked in. */
function excelSerialToDate(n: number): Date {
  return new Date(Math.round((n - 25569) * 86_400_000))
}

export function toDate(v: unknown): string | undefined {
  if (v == null || v === '') return undefined
  if (v instanceof Date) return toISODate(v)
  if (typeof v === 'number') {
    // Plausible Excel serial range: 1980 through 2100.
    if (v > 25_000 && v < 80_000) return toISODate(excelSerialToDate(v))
    return undefined
  }
  const s = String(v).trim()
  if (!s) return undefined
  // Prefer unambiguous ISO.
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s)) return toISODate(new Date(s))
  const parsed = Date.parse(s)
  if (!Number.isNaN(parsed)) return toISODate(new Date(parsed))
  return undefined
}

export function toYear(v: unknown): number | undefined {
  const n = toNumber(v)
  if (n != null && n >= 1995 && n <= 2100) return Math.trunc(n)
  const d = toDate(v)
  if (d) {
    const y = Number.parseInt(d.slice(0, 4), 10)
    if (y >= 1995 && y <= 2100) return y
  }
  const s = toText(v)
  const m = s?.match(/\b(19|20)\d{2}\b/)
  return m ? Number.parseInt(m[0], 10) : undefined
}

const GRADERS = ['PSA', 'BGS', 'CGC', 'SGC', 'ACE', 'TAG'] as const
export type Grader = (typeof GRADERS)[number]

/** Pull "PSA 10" / "CGC 9.5" / "BGS 9.5 (Black Label)" out of a condition cell. */
export function parseGrade(
  condition?: string,
  graderCol?: string,
  gradeCol?: unknown,
): { grader: Grader | null; grade: number | null } {
  const text = `${graderCol ?? ''} ${condition ?? ''}`.toUpperCase()
  const grader = GRADERS.find((g) => new RegExp(`\\b${g}\\b`).test(text)) ?? null
  let grade = toNumber(gradeCol) ?? null
  if (grade == null && condition) {
    const m = text.match(/\b(?:PSA|BGS|CGC|SGC|ACE|TAG)\s*(10|\d(?:\.5)?)\b/)
    if (m) grade = Number.parseFloat(m[1])
  }
  if (grade != null && (grade < 1 || grade > 10)) grade = null
  return { grader, grade }
}

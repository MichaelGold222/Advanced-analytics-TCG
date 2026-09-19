/**
 * Spreadsheet ingest.
 *
 * The goal is that an existing collection sheet imports without being
 * reformatted: headers are matched by alias, columns are claimed by best
 * score, and anything unmatched is reported rather than silently dropped.
 */
import Papa from 'papaparse'
import { classify, parseSegment } from './classify'
import { itemKey } from './key'
import { parseGrade, toDate, toNumber, toText, toYear } from './parse-values'
import type { Holding, PricePoint, Segment, WatchItem } from './types'

export type Cell = string | number | boolean | Date | null
export interface RawSheet {
  name: string
  rows: Cell[][]
}

/** Canonical fields we try to find, best alias first. */
const FIELD_ALIASES = {
  name: ['card name', 'item name', 'product name', 'card', 'item', 'product', 'name', 'description', 'title'],
  set: ['set name', 'expansion', 'set', 'series', 'edition'],
  number: ['card number', 'collector number', 'card no', 'number', 'card #', 'no'],
  year: ['release year', 'year', 'released'],
  condition: ['condition', 'grade label', 'grading', 'cond'],
  grader: ['grading company', 'grader', 'company', 'cert company'],
  cert: [
    'cert number', 'certificate number', 'certification number', 'graded cert', 'cert #', 'cert no',
    'cert id', 'cert', 'certificate', 'certification', 'serial number', 'slab id', 'psa #', 'bgs #',
    'cgc #', 'sgc #',
  ],
  grade: ['grade', 'numeric grade'],
  quantity: ['quantity', 'qty', 'count', 'units', 'copies'],
  costBasis: [
    'cost basis', 'purchase price', 'buy price', 'price paid', 'paid', 'cost',
    'acquisition price', 'my cost',
  ],
  purchaseDate: ['purchase date', 'date acquired', 'date bought', 'acquired', 'buy date', 'date'],
  userPrice: [
    'market value', 'market price', 'current price', 'current value', 'fmv',
    'fair market value', 'value', 'last sale', 'price',
  ],
  segment: ['segment', 'category', 'bucket', 'type', 'class', 'group'],
  language: ['language', 'lang'],
  notes: ['notes', 'note', 'comments', 'comment', 'remarks'],
  askingPrice: ['asking price', 'ask', 'listed price', 'list price', 'offer price', 'seller price'],
  targetPrice: ['target price', 'max price', 'max bid', 'budget', 'target', 'my max'],
} as const

export type FieldName = keyof typeof FIELD_ALIASES
export type ColumnMap = Partial<Record<FieldName, number>>

/** Lower-case, split camelCase, and reduce punctuation to single spaces. */
export function normalizeHeader(header: string): string {
  return header
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9#\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const boundaryCache = new Map<string, RegExp>()

/**
 * Where an alias appears in a header, as whole words.
 *
 * Matching on raw substrings reads "Graded Cert #" as a grade column, because
 * it starts with the letters of "grade" — and then the cert number, which is
 * what actually matches a slab to its sales, is never read at all. An alias
 * has to land on word boundaries to count.
 */
function wordMatch(h: string, a: string): 'exact' | 'edge' | 'inside' | null {
  if (h === a) return 'exact'
  let re = boundaryCache.get(a)
  if (!re) {
    const escaped = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`)
    boundaryCache.set(a, re)
  }
  if (!re.test(h)) return null
  return h.startsWith(`${a} `) || h.endsWith(` ${a}`) ? 'edge' : 'inside'
}

function headerScore(header: string, aliases: readonly string[]): number {
  const h = normalizeHeader(header)
  if (!h) return 0
  for (let i = 0; i < aliases.length; i++) {
    const a = aliases[i]
    // Earlier aliases are stronger; exact beats edge beats inside.
    const rank = 1 - i / (aliases.length * 4)
    const where = wordMatch(h, a)
    if (where === 'exact') return 100 * rank
    if (where === 'edge') return 70 * rank
    if (where === 'inside') return 50 * rank
  }
  return 0
}

/**
 * Assign each field the best-scoring unclaimed column.
 * Fields compete: the highest score anywhere wins first, so an ambiguous
 * "Price" header goes to whichever field has no better candidate.
 */
export function mapColumns(headers: string[]): ColumnMap {
  const candidates: { field: FieldName; col: number; score: number }[] = []
  for (const field of Object.keys(FIELD_ALIASES) as FieldName[]) {
    headers.forEach((h, col) => {
      const score = headerScore(h, FIELD_ALIASES[field])
      if (score > 0) candidates.push({ field, col, score })
    })
  }
  candidates.sort((a, b) => b.score - a.score)
  const map: ColumnMap = {}
  const takenCols = new Set<number>()
  for (const c of candidates) {
    if (map[c.field] != null || takenCols.has(c.col)) continue
    map[c.field] = c.col
    takenCols.add(c.col)
  }
  return map
}

/** Find the header row: the first row that maps at least a name-ish column. */
export function findHeaderRow(rows: Cell[][]): number {
  const limit = Math.min(rows.length, 20)
  let best = -1
  let bestScore = 0
  for (let i = 0; i < limit; i++) {
    const headers = rows[i].map((c) => toText(c) ?? '')
    const filled = headers.filter(Boolean).length
    if (filled < 2) continue
    const map = mapColumns(headers)
    const score = Object.keys(map).length + (map.name != null ? 3 : 0)
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }
  return best
}

export interface ImportIssue {
  row: number
  message: string
}

export interface ImportResult<T> {
  items: T[]
  /** Headers we could not place, echoed back so nothing vanishes silently. */
  unmappedHeaders: string[]
  mapped: Partial<Record<FieldName, string>>
  issues: ImportIssue[]
  priceHistory: Record<string, PricePoint[]>
  sheetName: string
}

/** A header cell that is itself a date turns that column into a price observation. */
function detectDateColumns(headers: string[]): { col: number; date: string }[] {
  const out: { col: number; date: string }[] = []
  headers.forEach((h, col) => {
    if (!h) return
    // Guard against "2024 Topps"-style text: require a full date or YYYY-MM.
    if (!/^\s*(\d{4}[-/]\d{1,2}([-/]\d{1,2})?|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\s*$/.test(h)) return
    const d = toDate(h)
    if (d) out.push({ col, date: d })
  })
  return out
}

function baseFields(row: Cell[], map: ColumnMap) {
  const get = (f: FieldName) => (map[f] != null ? row[map[f]!] : undefined)
  const name = toText(get('name'))
  const set = toText(get('set'))
  const number = toText(get('number'))
  const condition = toText(get('condition'))
  const { grader, grade } = parseGrade(condition, toText(get('grader')), get('grade'))
  // Certs are digits; a spreadsheet may hold one as a number, losing nothing.
  const cert = toText(get('cert'))?.replace(/\s+/g, '')
  const year = toYear(get('year'))
  const notes = toText(get('notes'))
  const override = parseSegment(get('segment'))
  const cls = classify({ name, set, number, year, notes, override })
  return {
    name,
    set,
    number,
    condition,
    grader,
    grade,
    cert,
    year: year ?? cls.inferredYear,
    notes,
    override,
    language: toText(get('language')),
    cls,
    get,
  }
}

export function rowsToHoldings(sheet: RawSheet): ImportResult<Holding> {
  const headerRow = findHeaderRow(sheet.rows)
  if (headerRow < 0) {
    return {
      items: [], unmappedHeaders: [], mapped: {}, priceHistory: {}, sheetName: sheet.name,
      issues: [{ row: 0, message: 'No header row found. Expect a row with at least a card/item name column.' }],
    }
  }
  const headers = sheet.rows[headerRow].map((c) => toText(c) ?? '')
  const map = mapColumns(headers)
  const dateCols = detectDateColumns(headers)
  const items: Holding[] = []
  const issues: ImportIssue[] = []
  const priceHistory: Record<string, PricePoint[]> = {}

  for (let r = headerRow + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r]
    if (!row || row.every((c) => c == null || c === '')) continue
    const f = baseFields(row, map)
    if (!f.name) {
      issues.push({ row: r + 1, message: 'Skipped: no card or item name in this row.' })
      continue
    }
    const quantity = toNumber(f.get('quantity')) ?? 1
    const costBasis = toNumber(f.get('costBasis')) ?? 0
    const userPrice = toNumber(f.get('userPrice'))
    const key = itemKey({ name: f.name, set: f.set, number: f.number, grader: f.grader, grade: f.grade })

    items.push({
      id: `${key}#${r}`,
      name: f.name,
      set: f.set,
      number: f.number,
      year: f.year,
      condition: f.condition,
      grader: f.grader,
      grade: f.grade,
      cert: f.cert,
      quantity: quantity > 0 ? quantity : 1,
      costBasis,
      purchaseDate: toDate(f.get('purchaseDate')),
      userPrice,
      language: f.language,
      notes: f.notes,
      segmentOverride: f.override,
      segment: f.cls.segment,
      segmentReason: f.cls.reason,
    })

    if (quantity <= 0) issues.push({ row: r + 1, message: `Quantity "${toText(f.get('quantity'))}" is not positive; treated as 1.` })

    for (const { col, date } of dateCols) {
      const price = toNumber(row[col])
      if (price != null && price > 0) {
        ;(priceHistory[key] ??= []).push({ date, price, source: 'user' })
      }
    }
  }

  // A graded sheet with no cert column imports cleanly and then prices
  // nothing, because a cert is the only thing that matches a slab to its own
  // sales. Say so at import rather than leaving it to be discovered later.
  const gradedCount = items.filter((i) => i.grade != null).length
  if (map.cert == null && gradedCount > 0) {
    issues.push({
      row: headerRow + 1,
      message: `${gradedCount} graded card${gradedCount === 1 ? '' : 's'} here, but no certificate number column was found. `
        + 'Graded cards are priced from the sales of that exact slab, so they cannot be valued without one. '
        + 'Add a column headed "Cert Number".',
    })
  }

  const claimed = new Set(Object.values(map))
  return {
    items,
    unmappedHeaders: headers.filter((h, i) => h && !claimed.has(i) && !dateCols.some((d) => d.col === i)),
    mapped: Object.fromEntries(
      (Object.keys(map) as FieldName[]).map((f) => [f, headers[map[f]!]]),
    ) as Partial<Record<FieldName, string>>,
    issues,
    priceHistory,
    sheetName: sheet.name,
  }
}

export function rowsToWatchItems(sheet: RawSheet): ImportResult<WatchItem> {
  const headerRow = findHeaderRow(sheet.rows)
  if (headerRow < 0) {
    return {
      items: [], unmappedHeaders: [], mapped: {}, priceHistory: {}, sheetName: sheet.name,
      issues: [{ row: 0, message: 'No header row found. Expect a row with at least a card/item name column.' }],
    }
  }
  const headers = sheet.rows[headerRow].map((c) => toText(c) ?? '')
  const map = mapColumns(headers)
  const dateCols = detectDateColumns(headers)
  const items: WatchItem[] = []
  const issues: ImportIssue[] = []
  const priceHistory: Record<string, PricePoint[]> = {}

  for (let r = headerRow + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r]
    if (!row || row.every((c) => c == null || c === '')) continue
    const f = baseFields(row, map)
    if (!f.name) continue
    const key = itemKey({ name: f.name, set: f.set, number: f.number, grader: f.grader, grade: f.grade })
    items.push({
      id: `${key}#w${r}`,
      name: f.name,
      set: f.set,
      number: f.number,
      year: f.year,
      condition: f.condition,
      grader: f.grader,
      grade: f.grade,
      cert: f.cert,
      // An "asking price" column wins; otherwise a generic price column is the ask.
      askingPrice: toNumber(f.get('askingPrice')) ?? toNumber(f.get('userPrice')),
      targetPrice: toNumber(f.get('targetPrice')),
      quantity: toNumber(f.get('quantity')) ?? 1,
      notes: f.notes,
      segmentOverride: f.override,
      segment: f.cls.segment,
      segmentReason: f.cls.reason,
    })

    for (const { col, date } of dateCols) {
      const price = toNumber(row[col])
      if (price != null && price > 0) {
        ;(priceHistory[key] ??= []).push({ date, price, source: 'user' })
      }
    }
  }
  // A graded sheet with no cert column imports cleanly and then prices
  // nothing, because a cert is the only thing that matches a slab to its own
  // sales. Say so at import rather than leaving it to be discovered later.
  const gradedCount = items.filter((i) => i.grade != null).length
  if (map.cert == null && gradedCount > 0) {
    issues.push({
      row: headerRow + 1,
      message: `${gradedCount} graded card${gradedCount === 1 ? '' : 's'} here, but no certificate number column was found. `
        + 'Graded cards are priced from the sales of that exact slab, so they cannot be valued without one. '
        + 'Add a column headed "Cert Number".',
    })
  }

  const claimed = new Set(Object.values(map))
  return {
    items,
    unmappedHeaders: headers.filter((h, i) => h && !claimed.has(i) && !dateCols.some((d) => d.col === i)),
    mapped: Object.fromEntries(
      (Object.keys(map) as FieldName[]).map((f) => [f, headers[map[f]!]]),
    ) as Partial<Record<FieldName, string>>,
    issues,
    priceHistory,
    sheetName: sheet.name,
  }
}

/** Long-format price history: one row per observation. */
export function rowsToPriceHistory(sheet: RawSheet): Record<string, PricePoint[]> {
  const headerRow = findHeaderRow(sheet.rows)
  if (headerRow < 0) return {}
  const headers = sheet.rows[headerRow].map((c) => toText(c) ?? '')
  const map = mapColumns(headers)
  const lower = headers.map((h) => h.toLowerCase())
  const dateCol = lower.findIndex((h) => /date|as of|month/.test(h))
  const priceCol = lower.findIndex((h) => /price|value|sale|amount/.test(h))
  const volCol = lower.findIndex((h) => /volume|qty|quantity|sales|count/.test(h))
  if (dateCol < 0 || priceCol < 0 || map.name == null) return {}

  const out: Record<string, PricePoint[]> = {}
  for (let r = headerRow + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r]
    if (!row) continue
    const f = baseFields(row, map)
    const date = toDate(row[dateCol])
    const price = toNumber(row[priceCol])
    if (!f.name || !date || price == null || price <= 0) continue
    const key = itemKey({ name: f.name, set: f.set, number: f.number, grader: f.grader, grade: f.grade })
    ;(out[key] ??= []).push({
      date,
      price,
      source: 'sale',
      volume: volCol >= 0 ? toNumber(row[volCol]) : undefined,
    })
  }
  return out
}

const HISTORY_SHEET = /price|history|sales|comps|sold/i
const WATCH_SHEET = /watch|buy|target|wish|acquis|shopping/i

export async function readSheets(file: File): Promise<RawSheet[]> {
  if (/\.csv$/i.test(file.name) || file.type === 'text/csv') {
    const text = await file.text()
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true })
    return [{ name: file.name.replace(/\.csv$/i, ''), rows: parsed.data as Cell[][] }]
  }
  const { default: readXlsxFile } = await import('read-excel-file/browser')
  const sheets = await readXlsxFile(file)
  return sheets.map((s) => ({ name: s.sheet, rows: s.data as unknown as Cell[][] }))
}

export interface WorkbookImport {
  holdings: ImportResult<Holding>[]
  watchlist: ImportResult<WatchItem>[]
  priceHistory: Record<string, PricePoint[]>
}

/** Route each sheet by its name, then merge every price observation found. */
export async function importWorkbook(file: File, mode: 'portfolio' | 'watchlist'): Promise<WorkbookImport> {
  const sheets = await readSheets(file)
  const result: WorkbookImport = { holdings: [], watchlist: [], priceHistory: {} }

  for (const sheet of sheets) {
    if (sheet.rows.length === 0) continue
    if (HISTORY_SHEET.test(sheet.name)) {
      mergeHistory(result.priceHistory, rowsToPriceHistory(sheet))
      continue
    }
    const isWatch = WATCH_SHEET.test(sheet.name) || (mode === 'watchlist' && !/portfolio|holding|collection/i.test(sheet.name))
    if (isWatch) {
      const r = rowsToWatchItems(sheet)
      result.watchlist.push(r)
      mergeHistory(result.priceHistory, r.priceHistory)
    } else {
      const r = rowsToHoldings(sheet)
      result.holdings.push(r)
      mergeHistory(result.priceHistory, r.priceHistory)
    }
  }
  return result
}

export function mergeHistory(into: Record<string, PricePoint[]>, from: Record<string, PricePoint[]>): void {
  for (const [k, pts] of Object.entries(from)) {
    const target = (into[k] ??= [])
    for (const p of pts) {
      if (!target.some((e) => e.date === p.date && e.price === p.price && e.source === p.source)) target.push(p)
    }
  }
}

export function reclassify<T extends { name: string; set?: string; number?: string; year?: number; notes?: string; segmentOverride?: Segment | null }>(
  item: T,
): { segment: Segment; segmentReason: string } {
  const c = classify({ ...item, override: item.segmentOverride })
  return { segment: c.segment, segmentReason: c.reason }
}

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
  /**
   * True when `name` is really the file's name, not a tab the owner named.
   *
   * A CSV has no sheet names, so one is made up from the filename. That
   * invented name must never outrank the button the person pressed: a
   * workbook tab called "Watchlist" is a deliberate statement about its
   * contents, and `my collection sept.csv` is what a file happened to be
   * called.
   */
  nameIsFilename?: boolean
}

/** Canonical fields we try to find, best alias first. */
const FIELD_ALIASES = {
  name: [
    'card name', 'item name', 'product name', 'card', 'item', 'product', 'name', 'description',
    'title',
    // What a grader's export calls the card. Last, so an explicit name column
    // always wins when a sheet carries both.
    'subject', 'player',
  ],
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
  quantity: ['quantity', 'qty', 'count', 'units', 'unit', 'copies', 'no of cards', '# of cards'],
  costBasis: [
    'cost basis', 'purchase price', 'buy price', 'price paid', 'paid', 'cost',
    'acquisition price', 'my cost', 'cost per unit', 'cost unit', 'price per card',
    'purchase', 'bought', 'basis', 'spent', 'buy in', 'entry price', 'price bought',
  ],
  /**
   * What the whole position cost, already multiplied out — as opposed to
   * costBasis, which is per unit. Kept separate because confusing the two
   * multiplies a position's cost by its own quantity.
   */
  investment: [
    'total investment', 'amount invested', 'total cost', 'total paid', 'total spent',
    'investment', 'invested', 'book value', 'total basis', 'capital', 'total',
  ],
  purchaseDate: ['purchase date', 'date acquired', 'date bought', 'acquired', 'buy date', 'date'],
  userPrice: [
    'market value', 'market price', 'current price', 'current value', 'fmv',
    'fair market value', 'value', 'last sale', 'price',
  ],
  segment: ['segment', 'category', 'bucket', 'type', 'class', 'group'],
  language: ['language', 'lang'],
  notes: ['notes', 'note', 'comments', 'comment', 'remarks'],
  /**
   * What distinguishes two printings of the same card at the same grade.
   *
   * Shadowless, 1st Edition, Reverse Holo, a staff stamp. Part of the identity,
   * not decoration: a Shadowless Base Charizard and an Unlimited one share a
   * name, a set, a number and a grade, and are worth wildly different money.
   * Left out of the key they became one item with one merged price history.
   */
  variation: ['variation', 'variety', 'parallel', 'finish', 'printing', 'subset', 'attribute'],
  /** Graded population for this card at this grade. Recorded, not yet modelled. */
  population: ['population', 'pop count', 'pop report', 'psa pop', 'pop'],
  askingPrice: ['asking price', 'ask', 'listed price', 'list price', 'offer price', 'seller price'],
  targetPrice: ['target price', 'max price', 'max bid', 'budget', 'target', 'my max'],
  /**
   * A profit or return column, recognised so that it can be ignored.
   *
   * Nothing reads it. Gain is computed from cost and current value, and a
   * figure typed into a sheet is a snapshot of whatever the market was doing
   * the day it was typed. Claiming the column is still worth doing: an
   * unrecognised header gets listed back at the owner as if something had gone
   * wrong with their file, and a header this common should not be a puzzle.
   */
  profit: [
    'potential profit', 'unrealized gain', 'unrealised gain', 'unrealized', 'unrealised',
    'profit loss', 'gain loss', 'profit', 'gain', 'p l', 'roi', 'return', 'upside',
  ],
} as const

export type FieldName = keyof typeof FIELD_ALIASES

/**
 * Fields that describe owning a card, which a watchlist by definition does not.
 *
 * A watchlist is things not bought yet, so what they cost, when they were
 * bought and what they have made are all answers to questions that have not
 * been asked. Sheets carry the columns anyway — people copy a holdings
 * template, or their export insists — and the columns are recognised precisely
 * so they can be set aside on purpose and said to have been, rather than
 * silently mapped to a field nothing reads or listed back as unrecognised.
 */
export const OWNERSHIP_FIELDS = ['costBasis', 'investment', 'purchaseDate', 'profit'] as const

/**
 * Whether a header is one of the given fields' by any of their names.
 *
 * Needed as well as the column map because a field claims at most one column,
 * and a sheet happily carries two of a kind — "Unrealized Gain" beside "ROI",
 * "Cost" beside "Total Cost". The map takes the better one and the rest would
 * otherwise be reported as unreadable, which is the opposite of true: they are
 * understood perfectly well and are simply not wanted here.
 */
export function matchesAnyField(header: string, fields: readonly FieldName[]): boolean {
  return fields.some((f) => headerScore(header, FIELD_ALIASES[f]) > 0)
}

const ALL_FIELDS = Object.keys(FIELD_ALIASES) as FieldName[]

/**
 * Split leftover headers into the understood ones and the genuine puzzles.
 *
 * Two ways a header ends up unclaimed. It may be one this app has no use for
 * here — cost on a watchlist, a stated profit anywhere — or it may be a second
 * column of a kind already taken, since a field claims only one: a sheet with
 * "Card Name" beside "Subject" has two names and can use one.
 *
 * Neither is a fault in the file, and reporting them as unrecognised says the
 * app could not read something it understands perfectly well. Only a header
 * matching nothing at all is worth flagging, because only that one might mean
 * a column is being missed.
 */
function partitionLeftovers(leftovers: string[], fields: readonly FieldName[]) {
  const ignored: string[] = []
  const unmapped: string[] = []
  for (const h of leftovers) {
    const known = matchesAnyField(h, fields) || matchesAnyField(h, ALL_FIELDS)
    ;(known ? ignored : unmapped).push(h)
  }
  return { ignored, unmapped }
}
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
  /**
   * Headers recognised and deliberately set aside — cost, purchase date and
   * profit on a watchlist, a stated profit anywhere. Kept apart from the
   * unrecognised ones so "not relevant here" does not read as "unreadable".
   */
  ignoredHeaders: string[]
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
  const variation = toText(get('variation'))
  const population = toNumber(get('population'))
  const override = parseSegment(get('segment'))
  const cls = classify({ name, set, number, year, notes, override })
  return {
    name,
    set,
    number,
    variation,
    population: population ?? undefined,
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

/**
 * Cost per unit, from whichever the sheet actually carries.
 *
 * Holdings store cost per unit and multiply by quantity everywhere, so a
 * column holding the position total has to be divided back down — read as-is
 * it would be multiplied by that quantity a second time. Where a sheet has
 * both, the total wins: it is the figure its owner reconciles against.
 */
export function perUnitCost(cost: Cell | undefined, investment: Cell | undefined, quantity: number): number {
  const total = toNumber(investment ?? null)
  const units = quantity > 0 ? quantity : 1
  if (total != null && total > 0) return total / units
  return toNumber(cost ?? null) ?? 0
}

export function rowsToHoldings(sheet: RawSheet): ImportResult<Holding> {
  const headerRow = findHeaderRow(sheet.rows)
  if (headerRow < 0) {
    return {
      items: [], unmappedHeaders: [], ignoredHeaders: [], mapped: {}, priceHistory: {}, sheetName: sheet.name,
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
    const costBasis = perUnitCost(f.get('costBasis'), f.get('investment'), quantity)
    const userPrice = toNumber(f.get('userPrice'))
    const key = itemKey({
      name: f.name, set: f.set, number: f.number, variation: f.variation,
      grader: f.grader, grade: f.grade,
    })

    items.push({
      id: `${key}#${r}`,
      name: f.name,
      set: f.set,
      number: f.number,
      year: f.year,
      variation: f.variation,
      population: f.population,
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

  // A sheet with asking or target prices and nothing about what was paid is a
  // list of things being considered, not things owned. Landing it here counts
  // it in the portfolio total and reports asking prices as wealth, so say so
  // plainly rather than importing it quietly and being believed.
  const noCost = map.costBasis == null && map.investment == null
  if (noCost && (map.askingPrice != null || map.targetPrice != null) && items.length > 0) {
    const tell = [
      map.askingPrice != null ? `"${headers[map.askingPrice]}"` : null,
      map.targetPrice != null ? `"${headers[map.targetPrice]}"` : null,
    ].filter(Boolean).join(' and ')
    issues.push({
      row: headerRow + 1,
      message: `This looks like a watchlist rather than holdings: it has ${tell} and no column for what `
        + 'was paid. Imported as holdings it counts toward the portfolio total as though these were owned. '
        + 'If that is not what you wanted, upload it again under "Upload watchlist", which replaces the '
        + 'watchlist, and then re-upload your real holdings sheet to clear these rows out.',
    })
  }

  // No cost column means every return reads as if the collection were free.
  // The header is usually there and simply spelled in a way we did not expect,
  // so name what was ignored: that is the column they need to point at.
  if (noCost && map.askingPrice == null && map.targetPrice == null && items.length > 0) {
    const claimed = new Set(Object.values(map))
    const ignored = headers.filter((h, i) => h && !claimed.has(i) && !dateCols.some((d) => d.col === i))
    issues.push({
      row: headerRow + 1,
      message: 'No cost column was recognised, so every position imported at a cost of 0 and its return '
        + 'is meaningless. Rename the column to "Cost" for a per-card price, or "Investment" for a '
        + 'position total.'
        + (ignored.length > 0 ? ` Columns ignored on this sheet: ${ignored.join(', ')}.` : ''),
    })
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
  // Cost and purchase date are read here; a stated profit still is not,
  // because gain is computed from cost and today's value rather than taken
  // from whatever the market was doing the day the cell was typed.
  const leftover = partitionLeftovers(
    headers.filter((h, i) => h && !claimed.has(i) && !dateCols.some((d) => d.col === i)),
    ['profit'],
  )
  return {
    items,
    unmappedHeaders: leftover.unmapped,
    ignoredHeaders: [
      ...(map.profit != null && headers[map.profit] ? [headers[map.profit]] : []),
      ...leftover.ignored,
    ],
    mapped: Object.fromEntries(
      (Object.keys(map) as FieldName[])
        .filter((f) => f !== 'profit')
        .map((f) => [f, headers[map[f]!]]),
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
      items: [], unmappedHeaders: [], ignoredHeaders: [], mapped: {}, priceHistory: {}, sheetName: sheet.name,
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
    const key = itemKey({
      name: f.name, set: f.set, number: f.number, variation: f.variation,
      grader: f.grader, grade: f.grade,
    })
    items.push({
      id: `${key}#w${r}`,
      name: f.name,
      set: f.set,
      number: f.number,
      year: f.year,
      variation: f.variation,
      population: f.population,
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
  const ignoredFields = OWNERSHIP_FIELDS.filter((f) => map[f] != null)
  const leftover = partitionLeftovers(
    headers.filter((h, i) => h && !claimed.has(i) && !dateCols.some((d) => d.col === i)),
    OWNERSHIP_FIELDS,
  )
  return {
    items,
    unmappedHeaders: leftover.unmapped,
    // Said separately from the unrecognised ones, because "this is not
    // relevant here" and "I do not know what this is" are different answers.
    ignoredHeaders: [
      ...ignoredFields.map((f) => headers[map[f]!]).filter(Boolean),
      ...leftover.ignored,
    ],
    mapped: Object.fromEntries(
      (Object.keys(map) as FieldName[])
        .filter((f) => !(OWNERSHIP_FIELDS as readonly string[]).includes(f))
        .map((f) => [f, headers[map[f]!]]),
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
    const key = itemKey({
      name: f.name, set: f.set, number: f.number, variation: f.variation,
      grader: f.grader, grade: f.grade,
    })
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
const PORTFOLIO_SHEET = /portfolio|holding|collection|inventory|owned/i

export async function readSheets(file: File): Promise<RawSheet[]> {
  if (/\.csv$/i.test(file.name) || file.type === 'text/csv') {
    const text = await file.text()
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true })
    return [{ name: file.name.replace(/\.csv$/i, ''), rows: parsed.data as Cell[][], nameIsFilename: true }]
  }
  const { default: readXlsxFile } = await import('read-excel-file/browser')
  const sheets = await readXlsxFile(file)
  return sheets.map((s) => ({ name: s.sheet, rows: s.data as unknown as Cell[][] }))
}

export interface WorkbookImport {
  holdings: ImportResult<Holding>[]
  watchlist: ImportResult<WatchItem>[]
  priceHistory: Record<string, PricePoint[]>
  /**
   * Where each sheet was sent, so the log can say it.
   *
   * Routing has now been wrong twice in ways nobody could see from the
   * outside: rows simply appeared in the wrong tab, with nothing on screen
   * saying a decision had been made at all. Stating it turns "it linked my
   * watchlist to my holdings" into one line naming the sheet and the
   * destination.
   */
  routed: { sheet: string; to: 'holdings' | 'watchlist' | 'price history' }[]
}

export type SheetTarget = 'holdings' | 'watchlist'

/**
 * Where one sheet's rows belong.
 *
 * The button the person pressed decides, and a name may only overrule it when
 * there is something to tell apart — that is, when the file holds more than one
 * sheet. A workbook with a Portfolio tab and a Watchlist tab needs its names
 * read; a file with a single sheet *is* the thing that was uploaded, and
 * whatever that sheet happens to be called is not a second opinion about which
 * button was pressed.
 *
 * Getting this wrong is expensive in a way that is easy to underrate. A
 * watchlist landing in holdings is counted as owned, so asking prices become
 * portfolio value; and because an import replaces, the watchlist it should have
 * filled is emptied in the same move. Two wrong places at once.
 *
 * It was wrong twice. First a CSV's invented name was read as though it were a
 * tab, so "my collection.csv" went to holdings. Then, with that fixed, a
 * single-sheet workbook whose one tab was called "Collection" — which is what
 * an export names it, and what anyone copying their holdings template would
 * have — did exactly the same thing.
 */
export function routeSheet(
  sheet: RawSheet,
  mode: SheetTarget | 'portfolio',
  sheetCount: number,
): SheetTarget {
  const chosen: SheetTarget = mode === 'watchlist' ? 'watchlist' : 'holdings'
  // A CSV has no tabs; the name was made up from the filename.
  const deliberate = sheet.nameIsFilename !== true && sheetCount > 1
  if (!deliberate) return chosen
  if (WATCH_SHEET.test(sheet.name)) return 'watchlist'
  if (PORTFOLIO_SHEET.test(sheet.name)) return 'holdings'
  return chosen
}

/**
 * Route each sheet, then merge every price observation found.
 *
 * The rule is that the button the person pressed outranks any guess made from
 * a name. It did not used to, and the cost of that was severe: a watchlist
 * uploaded through the watchlist zone from a file called something like
 * "my collection.csv" was routed to holdings, where it was counted as owned
 * and its asking prices went into the portfolio total — while the watchlist
 * itself, being a replace, was emptied. Two wrong places at once, from a word
 * in a filename.
 *
 * So a name only decides where a sheet goes when the name is a real one: a tab
 * the owner deliberately called "Watchlist" inside a workbook that may well
 * hold both. A CSV has no tabs, its name is the file's, and the mode decides.
 */
export async function importWorkbook(file: File, mode: 'portfolio' | 'watchlist'): Promise<WorkbookImport> {
  const sheets = await readSheets(file)
  const result: WorkbookImport = { holdings: [], watchlist: [], priceHistory: {}, routed: [] }

  for (const sheet of sheets) {
    if (sheet.rows.length === 0) continue

    // Long-format comps, but only when the sheet really is that shape. The
    // name alone is not enough: a watchlist called "sales pipeline" matches
    // the same words and is not a list of completed sales.
    if (HISTORY_SHEET.test(sheet.name)) {
      const history = rowsToPriceHistory(sheet)
      if (Object.keys(history).length > 0) {
        mergeHistory(result.priceHistory, history)
        result.routed.push({ sheet: sheet.name, to: 'price history' })
        continue
      }
    }

    if (routeSheet(sheet, mode, sheets.length) === 'watchlist') {
      const r = rowsToWatchItems(sheet)
      result.watchlist.push(r)
      mergeHistory(result.priceHistory, r.priceHistory)
      result.routed.push({ sheet: sheet.name, to: 'watchlist' })
    } else {
      const r = rowsToHoldings(sheet)
      result.holdings.push(r)
      mergeHistory(result.priceHistory, r.priceHistory)
      result.routed.push({ sheet: sheet.name, to: 'holdings' })
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

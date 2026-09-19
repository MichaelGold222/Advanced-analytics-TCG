/** Generating spreadsheets: the starter template, and an export of the analysis. */
import type { Row, SheetData } from 'write-excel-file/browser'
import { saveFile, type SaveOutcome } from './save-file'
import { SEGMENT_LABELS } from './types'
import type { Holding, ItemAnalysis, WatchItem } from './types'

const HEADER = { fontWeight: 'bold', backgroundColor: '#efeeea', align: 'left' } as const

function header(labels: string[]): Row {
  return labels.map((value) => ({ value, type: String, ...HEADER })) as Row
}

const PORTFOLIO_COLUMNS = [
  'Card Name', 'Set', 'Card Number', 'Year', 'Condition', 'Cert Number', 'Quantity',
  'Cost Basis', 'Purchase Date', 'Market Value', 'Segment', 'Notes',
]

const PORTFOLIO_EXAMPLES: (string | number | null)[][] = [
  ['Charizard', 'Base Set', '4', 1999, 'PSA 9', '12345678', 1, 4200, '2023-06-14', 5400, '', 'Shadowless'],
  ['Pikachu', 'Wizards Black Star Promos', '4', 1999, 'PSA 10', '87654321', 1, 900, '2024-02-02', 1250, '', 'Promo'],
  ['Surging Sparks Booster Box', 'Surging Sparks', '', 2024, 'Sealed', '', 2, 118, '2024-11-08', 145, '', ''],
  ['Moonbreon (Umbreon VMAX)', 'Evolving Skies', '215', 2021, 'CGC 9.5', '', 1, 1100, '2024-09-20', 980, '', 'Alt art'],
  ['Pikachu VMAX', 'Vivid Voltage', '044', 2020, 'NM', '', 3, 22, '2023-03-11', 18, 'Modern', 'Not a promo'],
]

const WATCHLIST_COLUMNS = [
  'Card Name', 'Set', 'Card Number', 'Year', 'Condition', 'Cert Number', 'Quantity', 'Asking Price', 'Target Price', 'Notes',
]

const WATCHLIST_EXAMPLES: (string | number | null)[][] = [
  ['Blastoise', 'Base Set', '2', 1999, 'PSA 8', '', 1, 1400, 1200, 'Watching a live auction'],
  ['Pikachu', 'SWSH Black Star Promos', 'SWSH284', 2022, 'PSA 10', '', 1, 260, 210, 'Trick or Trade'],
  ['Prismatic Evolutions Elite Trainer Box', 'Prismatic Evolutions', '', 2025, 'Sealed', '', 4, 62, 50, ''],
]

const HISTORY_COLUMNS = ['Card Name', 'Set', 'Card Number', 'Condition', 'Date', 'Price', 'Volume']

const HISTORY_EXAMPLES: (string | number | null)[][] = [
  ['Charizard', 'Base Set', '4', 'PSA 9', '2025-10-02', 5900, 3],
  ['Charizard', 'Base Set', '4', 'PSA 9', '2026-02-18', 5100, 2],
  ['Charizard', 'Base Set', '4', 'PSA 9', '2026-07-30', 5400, 4],
  ['Pikachu', 'Wizards Black Star Promos', '4', 'PSA 10', '2026-01-12', 1180, 1],
  ['Pikachu', 'Wizards Black Star Promos', '4', 'PSA 10', '2026-06-04', 1320, 2],
]

function toRows(columns: string[], examples: (string | number | null)[][]): SheetData {
  const rows: SheetData = [header(columns)]
  for (const ex of examples) {
    rows.push(ex.map((value) =>
      value === '' || value == null
        ? null
        : typeof value === 'number'
          ? { value, type: Number }
          : { value, type: String },
    ) as Row)
  }
  return rows
}

const README_ROWS: SheetData = [
  header(['How this workbook is read']),
  [{ value: 'Sheet names decide the role: "Portfolio" is what you own, "Watchlist" is what you are considering, "Price History" is past prices.', type: String }],
  [{ value: 'Column headers are matched by name, so your own wording is fine — "Paid", "Purchase Price" and "Cost Basis" all map to cost basis.', type: String }],
  [{ value: 'Only a card or item name is required. Everything else improves the analysis but is optional.', type: String }],
  [null],
  [{ value: 'Segments are inferred, in this order:', type: String, fontWeight: 'bold' }],
  [{ value: '1. Sealed — anything whose name says booster box, ETB, tin, pack, case, bundle or similar.', type: String }],
  [{ value: '2. Pikachu Promos — a Pikachu card carrying a promo marker (promo, black star, jumbo, a promo number like SWSH284).', type: String }],
  [{ value: '3. Vintage — released 2003 or earlier (the WotC era, Base Set through Skyridge).', type: String }],
  [{ value: '4. Modern — everything else.', type: String }],
  [{ value: 'Fill the Segment column to override any of that. You can also change it per row in the app.', type: String }],
  [null],
  [{ value: 'Price History is what makes the 52-week high real.', type: String, fontWeight: 'bold' }],
  [{ value: 'A single current price cannot produce a yearly high. Add your own sold comps here and the range, volatility and entry targets all sharpen.', type: String }],
  [{ value: 'The app also snapshots prices each time you refresh, so history builds up on its own as you use it.', type: String }],
  [{ value: 'Graded cards need graded comps: a TCGplayer-style quote prices a raw copy and is never blended into a slab’s value.', type: String }],
]

export async function downloadTemplate(): Promise<SaveOutcome> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser')
  return saveFile(
    writeXlsxFile(
    [
      { sheet: 'Portfolio', data: toRows(PORTFOLIO_COLUMNS, PORTFOLIO_EXAMPLES), columns: widths([28, 24, 12, 8, 12, 14, 9, 12, 14, 13, 14, 26]) },
      { sheet: 'Watchlist', data: toRows(WATCHLIST_COLUMNS, WATCHLIST_EXAMPLES), columns: widths([28, 24, 12, 8, 12, 14, 9, 13, 13, 26]) },
      { sheet: 'Price History', data: toRows(HISTORY_COLUMNS, HISTORY_EXAMPLES), columns: widths([28, 24, 12, 12, 12, 10, 9]) },
      { sheet: 'Read Me', data: README_ROWS, columns: widths([130]) },
    ]),
    'pokemon-portfolio-template.xlsx',
  )
}

function widths(ws: number[]) {
  return ws.map((width) => ({ width }))
}

const money = (v: number | null | undefined) =>
  v == null ? null : { value: Math.round(v * 100) / 100, type: Number as NumberConstructor, format: '#,##0.00' }
const pctCell = (v: number | null | undefined) =>
  v == null ? null : { value: Math.round(v * 1000) / 1000, type: Number as NumberConstructor, format: '0.0%' }
const text = (v: string | null | undefined) => (v == null || v === '' ? null : { value: v, type: String as StringConstructor })

const VERDICT_LABELS: Record<string, string> = {
  strong_buy: 'Strong buy', buy: 'Buy', fair: 'Fair', rich: 'Rich', overpriced: 'Overpriced', unknown: 'Unknown',
}

/** Export the current analysis so the numbers can be worked with outside the app. */
export async function exportAnalysis(
  holdings: Holding[],
  watchlist: WatchItem[],
  analyses: Map<string, ItemAnalysis>,
  keyOf: (item: { name: string; set?: string; number?: string; grader?: string | null; grade?: number | null }) => string,
): Promise<SaveOutcome> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser')
  const holdingRows: SheetData = [
    header(['Card Name', 'Set', 'Number', 'Segment', 'Qty', 'Cost Basis', 'FMV / unit', 'Market Value', 'Unrealized', 'ROI', 'Confidence', '52w High', '52w Low', 'Why this segment']),
  ]
  for (const h of holdings) {
    const a = analyses.get(keyOf(h))
    const fmv = a?.fmv.fmv ?? null
    const value = fmv == null ? null : fmv * h.quantity
    const cost = h.costBasis * h.quantity
    holdingRows.push([
      text(h.name), text(h.set), text(h.number), text(SEGMENT_LABELS[h.segment]),
      { value: h.quantity, type: Number }, money(cost), money(fmv), money(value),
      money(value == null ? null : value - cost),
      pctCell(value == null || cost <= 0 ? null : (value - cost) / cost),
      text(a?.fmv.confidence), money(a?.range.high), money(a?.range.low), text(h.segmentReason),
    ] as Row)
  }

  const watchRows: SheetData = [
    header(['Card Name', 'Set', 'Number', 'Segment', 'Asking', 'FMV', 'Confidence', 'Yearly High', 'Yearly Low', 'Good Entry', 'Stretch Entry', 'Verdict', 'Score', 'Reasoning']),
  ]
  for (const w of watchlist) {
    const a = analyses.get(keyOf(w))
    watchRows.push([
      text(w.name), text(w.set), text(w.number), text(SEGMENT_LABELS[w.segment]),
      money(w.askingPrice), money(a?.fmv.fmv), text(a?.fmv.confidence),
      money(a?.range.high), money(a?.range.low),
      money(a?.entry.entryPrice), money(a?.entry.stretchEntry),
      text(a ? VERDICT_LABELS[a.entry.verdict] : null),
      a?.entry.verdict === 'unknown' ? null : { value: a?.entry.score ?? 0, type: Number },
      text(a?.entry.rationale.join(' ')),
    ] as Row)
  }

  return saveFile(
    writeXlsxFile([
      { sheet: 'Portfolio Analysis', data: holdingRows, columns: widths([28, 22, 10, 14, 6, 12, 12, 13, 12, 9, 11, 11, 11, 44]) },
      { sheet: 'Watchlist Analysis', data: watchRows, columns: widths([28, 22, 10, 14, 11, 11, 11, 12, 12, 12, 13, 12, 7, 60]) },
    ]),
    `pokemon-analytics-${new Date().toISOString().slice(0, 10)}.xlsx`,
  )
}

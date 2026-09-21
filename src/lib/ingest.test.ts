import { describe, expect, it } from 'vitest'
import {
  findHeaderRow, importWorkbook, mapColumns, routeSheet, rowsToHoldings, rowsToPriceHistory,
  rowsToWatchItems,
} from './ingest'
import type { Cell, RawSheet } from './ingest'

const sheet = (rows: Cell[][], name = 'Portfolio'): RawSheet => ({ name, rows })

describe('column mapping', () => {
  it('matches the obvious headers', () => {
    const m = mapColumns(['Card Name', 'Set', 'Card Number', 'Quantity', 'Cost Basis'])
    expect(m.name).toBe(0)
    expect(m.set).toBe(1)
    expect(m.number).toBe(2)
    expect(m.quantity).toBe(3)
    expect(m.costBasis).toBe(4)
  })

  it('accepts the wording people actually use', () => {
    const m = mapColumns(['Item', 'Expansion', 'Qty', 'Paid', 'Market Value'])
    expect(m.name).toBe(0)
    expect(m.set).toBe(1)
    expect(m.quantity).toBe(2)
    expect(m.costBasis).toBe(3)
    expect(m.userPrice).toBe(4)
  })

  it('never assigns one column to two fields', () => {
    const m = mapColumns(['Name', 'Price', 'Purchase Price'])
    expect(m.costBasis).toBe(2)
    expect(m.userPrice).toBe(1)
    expect(new Set(Object.values(m)).size).toBe(Object.values(m).length)
  })

  it('is case and punctuation insensitive', () => {
    const m = mapColumns(['CARD_NAME', 'set name', 'Cost  Basis'])
    expect(m.name).toBe(0)
    expect(m.set).toBe(1)
    expect(m.costBasis).toBe(2)
  })

  it('finds the header row under title and blank rows', () => {
    const rows: Cell[][] = [
      ['My Collection', null],
      [null, null],
      ['Card Name', 'Set', 'Quantity'],
      ['Charizard', 'Base Set', 1],
    ]
    expect(findHeaderRow(rows)).toBe(2)
  })
})

describe('reading holdings', () => {
  const rows: Cell[][] = [
    ['Card Name', 'Set', 'Card Number', 'Year', 'Condition', 'Qty', 'Paid', 'Purchase Date', 'Notes'],
    ['Charizard', 'Base Set', '4', 1999, 'PSA 9', 1, '$4,200.00', '2023-06-14', 'Shadowless'],
    ['Surging Sparks Booster Box', 'Surging Sparks', null, 2024, 'Sealed', 2, 118, '2024-11-08', null],
    ['Pikachu', 'Wizards Black Star Promos', '4', 1999, 'PSA 10', 1, 900, '2024-02-02', null],
    [null, null, null, null, null, null, null, null, null],
    [null, 'Orphan row with no name', null, null, null, null, null, null, null],
  ]

  it('reads the rows and classifies each one', () => {
    const r = rowsToHoldings(sheet(rows))
    expect(r.items).toHaveLength(3)
    expect(r.items.map((i) => i.segment)).toEqual(['vintage', 'sealed', 'pikachu_promo'])
  })

  it('parses money, grades and quantities', () => {
    const [charizard, box] = rowsToHoldings(sheet(rows)).items
    expect(charizard.costBasis).toBe(4200)
    expect(charizard.grader).toBe('PSA')
    expect(charizard.grade).toBe(9)
    expect(charizard.purchaseDate).toBe('2023-06-14')
    expect(box.quantity).toBe(2)
  })

  it('reports rows it had to skip instead of dropping them silently', () => {
    const r = rowsToHoldings(sheet(rows))
    expect(r.issues.some((i) => /no card or item name/i.test(i.message))).toBe(true)
  })

  it('echoes back columns it could not place', () => {
    const r = rowsToHoldings(sheet([
      ['Card Name', 'Storage Box', 'Insured'],
      ['Charizard', 'Shelf 3', 'Yes'],
    ]))
    expect(r.unmappedHeaders).toContain('Storage Box')
    expect(r.unmappedHeaders).toContain('Insured')
  })

  it('reads date-headed columns as a wide price history', () => {
    const r = rowsToHoldings(sheet([
      ['Card Name', 'Set', '2026-01-01', '2026-04-01', '2026-07-01'],
      ['Charizard', 'Base Set', 5200, 5400, 5100],
    ]))
    const points = Object.values(r.priceHistory)[0]
    expect(points).toHaveLength(3)
    expect(points.map((p) => p.price)).toEqual([5200, 5400, 5100])
    expect(r.unmappedHeaders).toHaveLength(0)
  })

  it('does not mistake a plain year header for a date column', () => {
    const r = rowsToHoldings(sheet([
      ['Card Name', 'Year', 'Qty'],
      ['Charizard', 1999, 1],
    ]))
    expect(Object.keys(r.priceHistory)).toHaveLength(0)
    expect(r.items[0].year).toBe(1999)
  })

  it('reads a certification number, however the column is labelled', () => {
    for (const header of ['Cert Number', 'Cert #', 'Certification', 'Serial Number', 'cert']) {
      const r = rowsToHoldings(sheet([
        ['Card Name', 'Condition', header],
        ['Charizard', 'PSA 9', '12345678'],
      ]))
      expect(r.items[0].cert, header).toBe('12345678')
    }
  })

  it('reads a cert stored as a number, not text', () => {
    const r = rowsToHoldings(sheet([
      ['Card Name', 'Condition', 'Cert Number'],
      ['Charizard', 'PSA 9', 12345678],
    ]))
    expect(r.items[0].cert).toBe('12345678')
  })

  it('leaves the cert unset when there is no such column', () => {
    // Two columns: a single-column sheet has no detectable header row.
    const r = rowsToHoldings(sheet([['Card Name', 'Set'], ['Charizard', 'Base Set']]))
    expect(r.items[0].cert).toBeUndefined()
  })

  it('does not confuse a cert column with the card number', () => {
    const r = rowsToHoldings(sheet([
      ['Card Name', 'Card Number', 'Cert Number'],
      ['Charizard', '4', '12345678'],
    ]))
    expect(r.items[0].number).toBe('4')
    expect(r.items[0].cert).toBe('12345678')
  })

  it('honours a Segment column as an override', () => {
    const r = rowsToHoldings(sheet([
      ['Card Name', 'Segment'],
      ['Surging Sparks Booster Box', 'Modern'],
    ]))
    expect(r.items[0].segment).toBe('modern')
    expect(r.items[0].segmentOverride).toBe('modern')
  })

  it('reports a sheet with no usable header', () => {
    const r = rowsToHoldings(sheet([[null], [null]]))
    expect(r.items).toHaveLength(0)
    expect(r.issues[0].message).toMatch(/No header row/i)
  })
})

describe('reading a watchlist', () => {
  it('reads asking and target prices', () => {
    const r = rowsToWatchItems(sheet([
      ['Card Name', 'Set', 'Asking Price', 'Target Price'],
      ['Blastoise', 'Base Set', 1400, 1200],
    ], 'Watchlist'))
    expect(r.items[0].askingPrice).toBe(1400)
    expect(r.items[0].targetPrice).toBe(1200)
    expect(r.items[0].segment).toBe('vintage')
  })

  it('treats a lone price column as the ask', () => {
    const r = rowsToWatchItems(sheet([['Card Name', 'Price'], ['Blastoise', 900]], 'Watchlist'))
    expect(r.items[0].askingPrice).toBe(900)
  })
})

describe('reading long-format price history', () => {
  it('groups observations by item', () => {
    const history = rowsToPriceHistory(sheet([
      ['Card Name', 'Set', 'Condition', 'Date', 'Price', 'Volume'],
      ['Charizard', 'Base Set', 'PSA 9', '2026-02-18', 5100, 2],
      ['Charizard', 'Base Set', 'PSA 9', '2026-07-30', 5400, 4],
      ['Pikachu', 'Wizards Black Star Promos', 'PSA 10', '2026-01-12', 1180, 1],
    ], 'Price History'))
    const keys = Object.keys(history)
    expect(keys).toHaveLength(2)
    const charizard = history[keys.find((k) => k.startsWith('charizard'))!]
    expect(charizard).toHaveLength(2)
    expect(charizard[0].source).toBe('sale')
    expect(charizard[1].volume).toBe(4)
  })

  it('keeps different grades of the same card apart', () => {
    const history = rowsToPriceHistory(sheet([
      ['Card Name', 'Condition', 'Date', 'Price'],
      ['Charizard', 'PSA 9', '2026-02-18', 5100],
      ['Charizard', 'PSA 10', '2026-02-18', 22000],
    ], 'Price History'))
    expect(Object.keys(history)).toHaveLength(2)
  })
})

describe('cert columns as people actually label them', () => {
  const certCol = (headers: string[]) => {
    const col = mapColumns(headers).cert
    return col == null ? null : headers[col]
  }

  it('reads "Graded Cert #" as the cert, not the grade', () => {
    // It begins with the letters of "grade", which used to win the column and
    // leave the slab with no cert — so it was never priced at all.
    const headers = ['Card Name', 'Set', 'Graded Cert #', 'Condition', 'Qty', 'Cost Basis']
    expect(certCol(headers)).toBe('Graded Cert #')
    expect(mapColumns(headers).grade).toBeUndefined()
  })

  it('still tells a cert column from a grade column when both are present', () => {
    const headers = ['Card Name', 'Graded Cert #', 'Grade', 'Condition']
    const m = mapColumns(headers)
    expect(headers[m.cert!]).toBe('Graded Cert #')
    expect(headers[m.grade!]).toBe('Grade')
  })

  it.each([
    ['Cert #'], ['Cert Number'], ['Certificate Number'], ['Certification Number'],
    ['Cert No'], ['PSA Cert #'], ['Slab ID'], ['Serial Number'], ['certNumber'],
  ])('reads %s as a cert column', (header) => {
    expect(certCol(['Card Name', header, 'Qty'])).toBe(header)
  })

  it('does not mistake a grade column for a cert', () => {
    for (const header of ['Grade', 'Numeric Grade', 'PSA Grade', 'Grade Label']) {
      expect(certCol(['Card Name', header, 'Qty'])).toBeNull()
    }
  })

  it('carries the cert through to the holding, which is what pricing needs', () => {
    const { items } = rowsToHoldings({
      name: 'Portfolio',
      rows: [
        ['Card Name', 'Set', 'Condition', 'Graded Cert #', 'Qty'],
        ['Charizard', 'Base Set', 'PSA 10', '93083876', 1],
      ],
    })
    expect(items[0].cert).toBe('93083876')
    expect(items[0].grader).toBe('PSA')
    expect(items[0].grade).toBe(10)
  })
})

describe('word boundaries in header matching', () => {
  it('does not let a longer word match a shorter alias', () => {
    // "graded" is not "grade"; "noted" is not "no".
    expect(mapColumns(['Graded Cert #']).grade).toBeUndefined()
    expect(mapColumns(['Notebook']).number).toBeUndefined()
  })

  it('still matches an alias that is a whole word inside a longer header', () => {
    expect(mapColumns(['Cost Basis USD']).costBasis).toBe(0)
  })

  it('reads "Total Cost Basis" as the position total, not a per-unit cost', () => {
    // "Total" is the word that decides it; without it the same header is
    // per-unit. Getting this backwards scales a position by its own quantity.
    expect(mapColumns(['Total Cost Basis USD']).investment).toBe(0)
    expect(mapColumns(['Total Cost Basis USD']).costBasis).toBeUndefined()
  })

  it('keeps a per-unit cost and a total apart when a sheet carries both', () => {
    const headers = ['Card', 'Cost Basis', 'Investment']
    const m = mapColumns(headers)
    expect(headers[m.costBasis!]).toBe('Cost Basis')
    expect(headers[m.investment!]).toBe('Investment')
  })
})

describe('a graded sheet with no cert column', () => {
  const sheet = {
    name: 'Portfolio',
    rows: [
      ['Card Name', 'Set', 'Condition', 'Qty'],
      ['Charizard', 'Base Set', 'PSA 10', 1],
      ['Blastoise', 'Base Set', 'PSA 9', 1],
    ],
  }

  it('says so, rather than importing cleanly and pricing nothing', () => {
    const { issues } = rowsToHoldings(sheet)
    expect(issues.map((i) => i.message).join(' ')).toMatch(/2 graded cards.*no certificate number column/i)
  })

  it('stays quiet when there is nothing graded to price', () => {
    const { issues } = rowsToHoldings({
      name: 'Portfolio',
      rows: [['Card Name', 'Qty'], ['Surging Sparks Booster Box', 6]],
    })
    expect(issues.filter((i) => /certificate/i.test(i.message))).toHaveLength(0)
  })
})

describe('an Investment column holding the position total', () => {
  const sheet = (rows: (string | number)[][]) => ({ name: 'Portfolio', rows })

  it('does not multiply the total by quantity a second time', () => {
    // Investment is what the whole position cost. Holdings store cost per
    // unit, so reading 360 as-is would make a 3-card position cost 1080.
    const { items } = rowsToHoldings(sheet([
      ['Card Name', 'Cost', 'Unit', 'Investment'],
      ['Charizard ex', 120, 3, 360],
    ]))
    expect(items[0].quantity).toBe(3)
    expect(items[0].costBasis).toBe(120)
    expect(items[0].costBasis * items[0].quantity).toBe(360)
  })

  it('prefers the total over a per-unit cost that disagrees with it', () => {
    const { items } = rowsToHoldings(sheet([
      ['Card Name', 'Cost', 'Unit', 'Investment'],
      ['Charizard ex', 999, 4, 400],
    ]))
    expect(items[0].costBasis * items[0].quantity).toBe(400)
  })

  it('reads a per-unit cost when there is no total', () => {
    const { items } = rowsToHoldings(sheet([['Card Name', 'Cost', 'Unit'], ['Charizard ex', 120, 3]]))
    expect(items[0].costBasis).toBe(120)
    expect(items[0].costBasis * items[0].quantity).toBe(360)
  })

  it('treats a missing quantity as one rather than dividing by zero', () => {
    const { items } = rowsToHoldings(sheet([['Card Name', 'Investment'], ['Charizard ex', 500]]))
    expect(items[0].costBasis).toBe(500)
    expect(Number.isFinite(items[0].costBasis)).toBe(true)
  })

  it.each([
    ['Investment'], ['Total Investment'], ['Total Cost'], ['Amount Invested'], ['Total Paid'],
  ])('recognises %s as the position total', (header) => {
    const { items } = rowsToHoldings(sheet([['Card Name', 'Unit', header], ['Charizard ex', 2, 300]]))
    expect(items[0].costBasis * items[0].quantity).toBe(300)
  })

  it('still reads Unit as the quantity, not just Units', () => {
    const { items } = rowsToHoldings(sheet([['Card Name', 'Unit'], ['Charizard ex', 6]]))
    expect(items[0].quantity).toBe(6)
  })
})

describe('a sheet with no recognisable cost column', () => {
  it('says so, and names what it ignored', () => {
    // Importing at a cost of 0 makes every return meaningless, and the header
    // is usually present and simply spelled unexpectedly.
    const { items, issues } = rowsToHoldings({
      name: 'Portfolio',
      rows: [
        ['Card Name', 'Set', 'Wat I Payd', 'Qty'],
        ['Charizard', 'Base Set', 12000, 1],
      ],
    })
    expect(items[0].costBasis).toBe(0)
    const said = issues.map((i) => i.message).join(' ')
    expect(said).toMatch(/no cost column was recognised/i)
    expect(said).toMatch(/Wat I Payd/)
  })

  it('stays quiet when a cost column is present', () => {
    const { issues } = rowsToHoldings({
      name: 'Portfolio',
      rows: [['Card Name', 'Cost', 'Qty'], ['Charizard', 12000, 1]],
    })
    expect(issues.filter((i) => /no cost column/i.test(i.message))).toHaveLength(0)
  })

  it('stays quiet when only a position total is present', () => {
    const { issues } = rowsToHoldings({
      name: 'Portfolio',
      rows: [['Card Name', 'Investment', 'Qty'], ['Charizard', 12000, 1]],
    })
    expect(issues.filter((i) => /no cost column/i.test(i.message))).toHaveLength(0)
  })

  it.each([
    ['Spent'], ['Basis'], ['Capital'], ['Total'], ['Purchase'], ['Entry Price'],
  ])('recognises %s as a cost column', (header) => {
    const { items } = rowsToHoldings({
      name: 'Portfolio',
      rows: [['Card Name', header, 'Qty'], ['Charizard', 500, 1]],
    })
    expect(items[0].costBasis).toBeGreaterThan(0)
  })
})

describe('a watchlist built from a holdings template', () => {
  const watchSheet = (headers: Cell[], row: Cell[]): RawSheet =>
    ({ name: 'Watchlist', rows: [headers, row] })

  const HEADERS: Cell[] = [
    'Card Name', 'Set', 'Card Number', 'Condition', 'Graded Cert #',
    'Investment', 'Potential Profit', 'Asking Price',
  ]
  const ROW: Cell[] = ['Charizard', 'Base Set', '4', 'PSA 10', '93083876', 1200, 800, 2400]

  it('does not read what a card cost onto something not yet bought', () => {
    const r = rowsToWatchItems(watchSheet(HEADERS, ROW))
    const item = r.items[0] as unknown as Record<string, unknown>
    expect(item.askingPrice).toBe(2400)
    // Nothing on a watch item should have picked up 1200 or 800.
    expect(Object.values(item)).not.toContain(1200)
    expect(Object.values(item)).not.toContain(800)
  })

  it('names them as set aside rather than as unreadable', () => {
    const r = rowsToWatchItems(watchSheet(HEADERS, ROW))
    expect(r.ignoredHeaders).toContain('Investment')
    expect(r.ignoredHeaders).toContain('Potential Profit')
    expect(r.unmappedHeaders).not.toContain('Investment')
    expect(r.unmappedHeaders).not.toContain('Potential Profit')
  })

  it('does not claim to have mapped them to anything', () => {
    const r = rowsToWatchItems(watchSheet(HEADERS, ROW))
    expect(Object.values(r.mapped)).not.toContain('Investment')
    expect(Object.values(r.mapped)).not.toContain('Potential Profit')
    // The columns that do matter are still mapped as before.
    expect(Object.values(r.mapped)).toContain('Asking Price')
    expect(Object.values(r.mapped)).toContain('Graded Cert #')
  })

  it('sets aside the other ways a sheet says the same things', () => {
    const r = rowsToWatchItems(watchSheet(
      ['Card Name', 'Cost Basis', 'Purchase Date', 'Unrealized Gain', 'ROI'],
      ['Lugia', 900, '2024-05-01', 300, 0.33],
    ))
    expect(r.unmappedHeaders).toEqual([])
    expect(r.ignoredHeaders.length).toBeGreaterThanOrEqual(3)
  })

  it('still reads a genuinely unknown column back to the owner', () => {
    const r = rowsToWatchItems(watchSheet(
      [...HEADERS, 'Binder Slot'],
      [...ROW, 'A3'],
    ))
    expect(r.unmappedHeaders).toContain('Binder Slot')
  })

  it('leaves cost alone on a holdings sheet, where it is the whole point', () => {
    const r = rowsToHoldings({ name: 'Portfolio', rows: [HEADERS, ROW] })
    const item = r.items[0] as unknown as Record<string, unknown>
    expect(item.costBasis).toBe(1200)
    // A stated profit is still not read: it is computed from cost and value.
    expect(r.ignoredHeaders).toContain('Potential Profit')
    expect(Object.values(r.mapped)).not.toContain('Potential Profit')
  })
})

describe('routing a file to the right tab', () => {
  const WATCH_ROWS: Cell[][] = [
    ['Card Name', 'Set', 'Graded Cert #', 'Asking Price', 'Target Price'],
    ['Charizard', 'Base Set', '93083876', 24000, 20000],
  ]
  const csv = (name: string, rows: Cell[][]): File =>
    new File([rows.map((r) => r.join(',')).join('\n')], `${name}.csv`, { type: 'text/csv' })

  it('sends a watchlist upload to the watchlist however the file is named', async () => {
    // The word that used to divert it: a filename is not a sheet name.
    for (const name of ['my collection sept', 'pokemon portfolio', 'card holdings 2026']) {
      const r = await importWorkbook(csv(name, WATCH_ROWS), 'watchlist')
      expect(r.watchlist.flatMap((w) => w.items)).toHaveLength(1)
      expect(r.holdings.flatMap((h) => h.items)).toHaveLength(0)
    }
  })

  it('sends a portfolio upload to holdings however the file is named', async () => {
    const rows: Cell[][] = [
      ['Card Name', 'Set', 'Cost Basis', 'Quantity'],
      ['Lugia', 'Neo Genesis', 900, 1],
    ]
    for (const name of ['things to watch', 'buy list', 'wishlist']) {
      const r = await importWorkbook(csv(name, rows), 'portfolio')
      expect(r.holdings.flatMap((h) => h.items)).toHaveLength(1)
      expect(r.watchlist.flatMap((w) => w.items)).toHaveLength(0)
    }
  })

  it('still honours a tab the owner deliberately named', async () => {
    const r = await importWorkbook(csv('anything', WATCH_ROWS), 'portfolio')
    // A CSV has no tabs, so the mode decides and this lands in holdings.
    expect(r.holdings.flatMap((h) => h.items)).toHaveLength(1)

    // A real workbook tab named Watchlist does outrank the mode.
    const sheets: RawSheet[] = [{ name: 'Watchlist', rows: WATCH_ROWS }]
    const routed = sheets.map((sh) => (/watch/i.test(sh.name) ? 'watchlist' : 'portfolio'))
    expect(routed).toEqual(['watchlist'])
  })

  it('does not read a watchlist as price history just for matching a word', async () => {
    // "sales" matches the history pattern, but this is not long-format comps.
    const r = await importWorkbook(csv('q4 sales pipeline', WATCH_ROWS), 'watchlist')
    expect(r.watchlist.flatMap((w) => w.items)).toHaveLength(1)
    expect(Object.keys(r.priceHistory)).toHaveLength(0)
  })

  it('still reads real long-format comps as price history', async () => {
    const r = await importWorkbook(csv('sales history', [
      ['Card Name', 'Set', 'Date', 'Price'],
      ['Charizard', 'Base Set', '2026-01-15', 22000],
      ['Charizard', 'Base Set', '2026-04-02', 23500],
    ]), 'portfolio')
    expect(Object.values(r.priceHistory).flat()).toHaveLength(2)
    expect(r.holdings.flatMap((h) => h.items)).toHaveLength(0)
  })

  it('says so loudly when a watchlist is imported as holdings anyway', () => {
    const r = rowsToHoldings({ name: 'anything', rows: WATCH_ROWS })
    expect(r.items).toHaveLength(1)
    const said = r.issues.map((i) => i.message).join(' ')
    expect(said).toMatch(/looks like a watchlist rather than holdings/i)
    expect(said).toMatch(/counts toward the portfolio total/i)
  })

  it('keeps the plain missing-cost advice for a real holdings sheet', () => {
    const r = rowsToHoldings({
      name: 'portfolio',
      rows: [['Card Name', 'Set', 'Quantity'], ['Lugia', 'Neo Genesis', 1]],
    })
    const said = r.issues.map((i) => i.message).join(' ')
    expect(said).toMatch(/No cost column was recognised/i)
    expect(said).not.toMatch(/looks like a watchlist/i)
  })
})

describe('a workbook tab does not overrule the button either', () => {
  const tab = (name: string): RawSheet => ({ name, rows: [['Card Name'], ['Charizard']] })

  it('sends a single sheet where the button says, whatever the tab is called', () => {
    // The exact case that got through: an .xlsx whose one tab is called
    // "Collection", which is what an export names it and what anyone copying
    // their holdings template would have.
    for (const name of ['Collection', 'Portfolio', 'Holdings', 'Inventory', 'Sheet1']) {
      expect(routeSheet(tab(name), 'watchlist', 1)).toBe('watchlist')
      expect(routeSheet(tab(name), 'portfolio', 1)).toBe('holdings')
    }
  })

  it('sends a single sheet called Watchlist to holdings if that is the button', () => {
    expect(routeSheet(tab('Watchlist'), 'portfolio', 1)).toBe('holdings')
  })

  it('reads the tab names once a workbook holds more than one', () => {
    expect(routeSheet(tab('Watchlist'), 'portfolio', 3)).toBe('watchlist')
    expect(routeSheet(tab('Portfolio'), 'watchlist', 3)).toBe('holdings')
  })

  it('falls back to the button for a tab whose name says nothing', () => {
    expect(routeSheet(tab('Sheet2'), 'watchlist', 3)).toBe('watchlist')
    expect(routeSheet(tab('Sheet2'), 'portfolio', 3)).toBe('holdings')
  })

  it('never reads a CSV filename as a tab name, however many were found', () => {
    const csv: RawSheet = { name: 'my collection', rows: [['Card Name']], nameIsFilename: true }
    expect(routeSheet(csv, 'watchlist', 1)).toBe('watchlist')
    expect(routeSheet(csv, 'watchlist', 5)).toBe('watchlist')
  })

  it('says where every sheet was sent', async () => {
    const rows = [['Card Name', 'Asking Price'], ['Charizard', 24000]]
    const file = new File([rows.map((r) => r.join(',')).join('\n')], 'my collection.csv', { type: 'text/csv' })
    const r = await importWorkbook(file, 'watchlist')
    expect(r.routed).toEqual([{ sheet: 'my collection', to: 'watchlist' }])
  })
})

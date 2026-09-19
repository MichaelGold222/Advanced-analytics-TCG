import { describe, expect, it } from 'vitest'
import { findHeaderRow, mapColumns, rowsToHoldings, rowsToPriceHistory, rowsToWatchItems } from './ingest'
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

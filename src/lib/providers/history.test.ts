import { describe, expect, it } from 'vitest'
import { readHistorySales } from './cardladder-client'
import { usableCardId } from './cardladder'

describe('the card id the sales endpoints accept', () => {
  it('takes the Firestore document id a catalogued card carries', () => {
    // Measured: cert 141142901 -> this exact id, matching its picture URL.
    expect(usableCardId('Zrxi8aY5mAA6roFkKUVX')).toBe('Zrxi8aY5mAA6roFkKUVX')
  })

  it('refuses the 40-character hash an uncatalogued cert carries', () => {
    // Measured: passing this answered "Card with id ... not found" and still
    // cost a request. There is no point spending one on it.
    expect(usableCardId('69607fe85f2c82c4b16587a10c71e0337d523b8b')).toBeNull()
  })

  it('refuses nothing at all', () => {
    expect(usableCardId(undefined)).toBeNull()
    expect(usableCardId('')).toBeNull()
    expect(usableCardId('   ')).toBeNull()
    expect(usableCardId(12345)).toBeNull()
  })
})

describe('reading sales out of a response whose shape is unmeasured', () => {
  // get_card_sales_detail has never been called: the credits ran out first.
  // So the reader looks for an array of sales anywhere rather than assuming a
  // key, and a shape it cannot read costs the call and nothing else.
  const sale = (date: string, price: number) => ({ date, price })

  it('finds them under data.sales', () => {
    const body = { status: 'ok', data: { sales: [sale('2026-03-01', 100), sale('2026-04-01', 120)] } }
    expect(readHistorySales(body).map((s) => s.price)).toEqual([100, 120])
  })

  it('finds them under data.results, or sale_records, or at the root', () => {
    for (const body of [
      { data: { results: [sale('2026-03-01', 100)] } },
      { data: { sale_records: [sale('2026-03-01', 100)] } },
      [sale('2026-03-01', 100)],
    ]) {
      expect(readHistorySales(body)).toHaveLength(1)
    }
  })

  it('returns nothing rather than throwing on a shape it cannot read', () => {
    expect(readHistorySales({ error: 'nope' })).toEqual([])
    expect(readHistorySales(null)).toEqual([])
    expect(readHistorySales('not json')).toEqual([])
    expect(readHistorySales({ data: { sales: [{ nope: 1 }] } })).toEqual([])
  })

  it('sorts and dedupes what it finds', () => {
    const body = { data: { sales: [sale('2026-04-01', 120), sale('2026-03-01', 100), sale('2026-04-01', 120)] } }
    const out = readHistorySales(body)
    expect(out.map((s) => s.date)).toEqual(['2026-03-01', '2026-04-01'])
  })

  it('does not wander into an unrelated array of numbers', () => {
    expect(readHistorySales({ data: { page_sizes: [10, 20, 50], sales: [sale('2026-03-01', 100)] } }))
      .toHaveLength(1)
  })

  it('survives a response that refers to itself', () => {
    const body: Record<string, unknown> = { data: { sales: [sale('2026-03-01', 100)] } }
    body.self = body
    expect(readHistorySales(body)).toHaveLength(1)
  })
})

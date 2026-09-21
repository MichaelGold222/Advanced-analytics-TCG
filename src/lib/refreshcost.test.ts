import { describe, expect, it } from 'vitest'
import { HISTORY_CREDITS_PER_CARD, describeCost, estimateRefresh } from './refreshcost'
import type { PricePoint } from './types'

const NOW = new Date('2026-09-21T00:00:00Z')
const back = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10)
const sale = (d: number): PricePoint => ({ date: back(d), price: 1000, source: 'sale' })

const certs = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`)

const est = (over: Partial<Parameters<typeof estimateRefresh>[0]> = {}) => estimateRefresh({
  certs: [], certSales: {}, certCardIds: {}, certDeepFetched: {}, now: NOW, ...over,
})

describe('what the button will cost', () => {
  it('is three credits for a routine refresh of a whole collection', () => {
    // Everything already priced and covered: only the bulk search runs, and
    // it is charged per call, so 122 slabs cost what 3 would.
    const all = certs(122)
    const certSales = Object.fromEntries(all.map((c) => [c, [sale(350), sale(200), sale(10)]]))
    const c = est({ certs: all, certSales })
    expect(c.search).toBe(3)
    expect(c.price).toBe(0)
    expect(c.history).toBe(0)
    expect(c.total).toBe(3)
  })

  it('adds the price call only for certs the search could not answer', () => {
    const all = certs(122)
    const certSales = Object.fromEntries(all.slice(1).map((c) => [c, [sale(350), sale(10)]]))
    expect(est({ certs: all, certSales }).price).toBeGreaterThan(0)
  })

  it('charges one credit per card for history, not one per slab', () => {
    // Two slabs of the same card: one call between them.
    const certSales = { a: [sale(5)], b: [sale(5)] }
    const certCardIds = { a: 'SameCardIdXXXXXXXXXX', b: 'SameCardIdXXXXXXXXXX' }
    const c = est({ certs: ['a', 'b'], certSales, certCardIds })
    expect(c.cards).toBe(1)
    expect(c.certsCoveredByHistory).toBe(2)
    expect(c.history).toBe(HISTORY_CREDITS_PER_CARD)
  })

  it('never charges for a card whose history was already fetched', () => {
    const certSales = { a: [sale(5)] }
    const certCardIds = { a: 'CardIdXXXXXXXXXXXXXX' }
    expect(est({ certs: ['a'], certSales, certCardIds, certDeepFetched: { a: {} } }).history).toBe(0)
  })

  it('never charges for a card whose record already reaches back a year', () => {
    const certSales = { a: [sale(350), sale(100)] }
    const certCardIds = { a: 'CardIdXXXXXXXXXXXXXX' }
    expect(est({ certs: ['a'], certSales, certCardIds }).history).toBe(0)
  })

  it('never charges for a cert the catalogue has no id for', () => {
    expect(est({ certs: ['a'], certSales: { a: [sale(5)] } }).history).toBe(0)
  })

  it('counts a cert listed twice once', () => {
    expect(est({ certs: ['a', 'a', 'a'] }).certs).toBe(1)
  })

  it('costs nothing at all with no certs', () => {
    expect(est().total).toBe(0)
  })
})

describe('how the cost is worded', () => {
  it('says the number first, because that is what is being asked', () => {
    const certSales = { a: [sale(5)], b: [sale(5)] }
    const certCardIds = { a: 'CardOneXXXXXXXXXXXXX', b: 'CardTwoXXXXXXXXXXXXX' }
    const line = describeCost(est({ certs: ['a', 'b'], certSales, certCardIds }))
    expect(line).toMatch(/^About 3 credits: /)
    expect(line).toContain('full history of 2 cards')
    expect(line).toContain('charged once ever')
  })

  it('says when copies of one card share a call', () => {
    const certSales = { a: [sale(5)], b: [sale(5)] }
    const certCardIds = { a: 'SameCardIdXXXXXXXXXX', b: 'SameCardIdXXXXXXXXXX' }
    expect(describeCost(est({ certs: ['a', 'b'], certSales, certCardIds })))
      .toContain('copies of one card share a call')
  })

  it('says so when there is nothing to fetch', () => {
    expect(describeCost(est())).toMatch(/No certificate numbers/)
  })
})

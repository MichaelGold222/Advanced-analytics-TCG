import { describe, expect, it } from 'vitest'
import { salesToPricePoints, usableCardId } from './cardladder'

describe('the card id the sales endpoint accepts', () => {
  it('takes the Firestore document id a catalogued card carries', () => {
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
    expect(usableCardId(12345)).toBeNull()
  })
})

describe('the history get_card_sales actually returns', () => {
  // Verbatim rows from the live response, run 31, for the Umbreon VMAX PSA 10
  // behind card_id Zrxi8aY5mAA6roFkKUVX. 627 of these came back for 1 credit.
  const LIVE = [
    { date: '12/31/2025', price: 2912.5, count: 2 },
    { date: '12/31/2022', price: 814.5487333333333, count: 7 },
    { date: '12/31/2021', price: 707.25, count: 2 },
  ]

  it('reads the American date format they come in', () => {
    // The probe script could not, which made the run log say "no readable
    // dates" about data that was perfectly readable.
    expect(salesToPricePoints(LIVE as never).map((p) => p.date))
      .toEqual(['2021-12-31', '2022-12-31', '2025-12-31'])
  })

  it('keeps the sale count as volume, so a busy point outweighs a lone one', () => {
    const byDate = new Map(salesToPricePoints(LIVE as never).map((p) => [p.date, p]))
    expect(byDate.get('2022-12-31')!.volume).toBe(7)
    expect(byDate.get('2021-12-31')!.volume).toBe(2)
  })

  it('leaves volume unset when a row has no count', () => {
    const [p] = salesToPricePoints([{ date: '12/31/2025', price: 100 }] as never)
    expect(p.volume).toBeUndefined()
  })

  it('ignores a count that is not a usable number', () => {
    for (const count of [0, -3, 'seven', null, NaN]) {
      const [p] = salesToPricePoints([{ date: '12/31/2025', price: 100, count }] as never)
      expect(p.volume).toBeUndefined()
    }
  })

  it('gives a yearly band the five-sale feed could never reach', () => {
    const pts = salesToPricePoints(LIVE as never)
    const prices = pts.map((p) => p.price)
    expect(Math.max(...prices)).toBe(2912.5)
    expect(Math.min(...prices)).toBe(707.25)
  })
})

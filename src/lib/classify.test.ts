import { describe, expect, it } from 'vitest'
import { classify, parseSegment } from './classify'

describe('segment classification', () => {
  it('files sealed product as sealed', () => {
    expect(classify({ name: 'Surging Sparks Booster Box' }).segment).toBe('sealed')
    expect(classify({ name: 'Prismatic Evolutions Elite Trainer Box' }).segment).toBe('sealed')
    expect(classify({ name: 'Crown Zenith ETB' }).segment).toBe('sealed')
    expect(classify({ name: 'Charizard UPC' }).segment).toBe('sealed')
    expect(classify({ name: 'Hidden Fates Mini Tin' }).segment).toBe('sealed')
  })

  it('recognises a Pikachu promo only when a promo marker is present', () => {
    expect(classify({ name: 'Pikachu', set: 'Wizards Black Star Promos', year: 1999 }).segment).toBe('pikachu_promo')
    expect(classify({ name: 'Pikachu', number: 'SWSH284', year: 2022 }).segment).toBe('pikachu_promo')
    // A Pikachu from a main set is not a promo.
    expect(classify({ name: 'Pikachu VMAX', set: 'Vivid Voltage', number: '044', year: 2020 }).segment).toBe('modern')
    // Base Set Pikachu is vintage, not a promo.
    expect(classify({ name: 'Pikachu', set: 'Base Set', number: '58' }).segment).toBe('vintage')
  })

  it('puts product form ahead of the Pikachu bucket', () => {
    const r = classify({ name: 'Pikachu Black Star Promo Collection Box' })
    expect(r.segment).toBe('sealed')
    expect(r.reason).toMatch(/sealed/i)
  })

  it('treats the WotC era as vintage, by set name or by year', () => {
    expect(classify({ name: 'Charizard', set: 'Base Set' }).segment).toBe('vintage')
    expect(classify({ name: 'Lugia', set: 'Neo Genesis' }).segment).toBe('vintage')
    expect(classify({ name: 'Crystal Charizard', set: 'Skyridge' }).segment).toBe('vintage')
    expect(classify({ name: 'Some Card', year: 2003 }).segment).toBe('vintage')
    expect(classify({ name: 'Some Card', year: 2004 }).segment).toBe('modern')
  })

  it('infers the year from a vintage set name when the sheet omits it', () => {
    expect(classify({ name: 'Blastoise', set: 'Base Set' }).inferredYear).toBe(1999)
    expect(classify({ name: 'Feraligatr', set: 'Neo Genesis' }).inferredYear).toBe(2000)
  })

  it('names the set in readable form when it explains a vintage call', () => {
    expect(classify({ name: 'Charizard', set: 'Base Set' }).reason).toContain('Base Set')
    expect(classify({ name: 'Lugia', set: 'Neo Genesis' }).reason).toContain('Neo Genesis')
    expect(classify({ name: 'Crystal Charizard', set: 'Skyridge' }).reason).toContain('Skyridge')
  })

  it('lets an explicit override win over everything', () => {
    const r = classify({ name: 'Surging Sparks Booster Box', override: 'modern' })
    expect(r.segment).toBe('modern')
    expect(r.reason).toMatch(/explicitly/i)
  })

  it('falls back to modern and says so when nothing matches', () => {
    const r = classify({ name: 'Mystery Lot' })
    expect(r.segment).toBe('modern')
    expect(r.reason).toMatch(/No year or set matched/i)
  })

  it('always explains itself', () => {
    for (const name of ['Base Set Charizard', 'Pikachu promo SWSH284', 'Booster Box', 'Iono 2023']) {
      expect(classify({ name }).reason.length).toBeGreaterThan(0)
    }
  })

  it('maps free-text category cells onto segments', () => {
    expect(parseSegment('Sealed Product')).toBe('sealed')
    expect(parseSegment('  VINTAGE ')).toBe('vintage')
    expect(parseSegment('Pikachu Promos')).toBe('pikachu_promo')
    expect(parseSegment('Modern')).toBe('modern')
    expect(parseSegment('')).toBeNull()
    expect(parseSegment(undefined)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { parseGrade, toDate, toNumber, toYear } from './parse-values'

describe('cell coercion', () => {
  it('reads money in the shapes spreadsheets produce', () => {
    expect(toNumber('$1,234.50')).toBe(1234.5)
    expect(toNumber('1234.5')).toBe(1234.5)
    expect(toNumber('(45)')).toBe(-45)
    expect(toNumber('€1.234,50')).toBe(1234.5)
    expect(toNumber(42)).toBe(42)
    expect(toNumber('')).toBeUndefined()
    expect(toNumber('n/a')).toBeUndefined()
    expect(toNumber(null)).toBeUndefined()
  })

  it('reads dates from strings and Excel serials', () => {
    expect(toDate('2026-03-05')).toBe('2026-03-05')
    expect(toDate(new Date('2026-03-05T00:00:00Z'))).toBe('2026-03-05')
    expect(toDate(45000)).toMatch(/^2023-/)
    expect(toDate('not a date')).toBeUndefined()
    // A small number is a quantity, not a date.
    expect(toDate(3)).toBeUndefined()
  })

  it('pulls a year out of whatever it is given', () => {
    expect(toYear(1999)).toBe(1999)
    expect(toYear('1999')).toBe(1999)
    expect(toYear('Released 2021')).toBe(2021)
    expect(toYear(12)).toBeUndefined()
  })

  it('splits a grade out of a condition cell', () => {
    expect(parseGrade('PSA 10')).toEqual({ grader: 'PSA', grade: 10 })
    expect(parseGrade('CGC 9.5')).toEqual({ grader: 'CGC', grade: 9.5 })
    expect(parseGrade('BGS 9.5 (Black Label)')).toEqual({ grader: 'BGS', grade: 9.5 })
    expect(parseGrade('NM')).toEqual({ grader: null, grade: null })
    expect(parseGrade(undefined, 'PSA', 9)).toEqual({ grader: 'PSA', grade: 9 })
    // Out-of-range grades are rejected rather than trusted.
    expect(parseGrade(undefined, 'PSA', 99)).toEqual({ grader: 'PSA', grade: null })
  })
})
